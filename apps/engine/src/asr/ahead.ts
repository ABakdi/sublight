import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  alignToWords,
  buildCuesFromWords,
  newId,
  type SpeechWord,
  type SubtitleTrack,
} from '@sublight/core'
import { COOKIE_BROWSERS, type UrlJob } from '@sublight/protocol'
import { JobError, type JobRunner, type RunOutput } from '../jobs/queue'
import { levelDb, SAMPLE_RATE, wavBytes } from '../live/session'
import type { FfmpegBinaries } from '../media/ffmpeg'
import type { Download } from '../media/relay'
import { probeMedia, resolveRemote, sliceRemote, type RemoteMedia } from '../media/remote'
import { SILENCE_DB } from '../media/store'
import type { ModelManager } from '../models/manager'
import { isWhisperLanguage, whisperLanguageCode } from './languages'
import { leadingSilenceMs, levelsFromPcm, onsetsFromLevels, snapToOnsets } from './onsets'
import { cuesFromSegments } from './segments'
import { promptFrom } from './transcribe'
import type { WhisperWorker } from './whisper'
import { segmentsFromVerbose, wordsFromVerbose } from './words'

/** The first piece after a (re)start is short, so captions are there within seconds. */
export const FIRST_PIECE_MS = 30_000
export const PIECE_MS = 120_000
/**
 * Audio fetched around a piece for context. Neighbouring pieces hear the same
 * words there, which is how they are joined (`composeWords`).
 */
export const CONTEXT_MS = 3000
/** How far a cut may move, forward and back, to land in a pause. */
const SNAP_MS = 5000
const SNAP_BACK_MS = 3000
/** Audio kept around a cut made in a pause (whisper likes a little lead-in). */
const PAUSE_LEAD_MS = 200
/** Don't leave a sliver this short to a later piece. */
const MIN_REST_MS = 10_000
/** Bump when output changes for the same input, so stale cache entries miss. */
const PIPELINE_VERSION = 6

export interface Range {
  startMs: number
  endMs: number
}

export interface Piece extends Range {
  /** It ends in a pause the runner chose, so its neighbour can start cleanly there. */
  atPause?: boolean
  /** The piece's own words: those starting inside it. */
  words: SpeechWord[]
  /** Everything heard, context included (media time), for joining neighbours by text. */
  heard?: SpeechWord[]
}

/** The stretch not yet transcribed at or after `focusMs` (else the first one before it). */
export function nextRange(
  done: Range[],
  durationMs: number,
  focusMs: number,
  sizeMs: number,
): Range | null {
  const sorted = [...done].sort((a, b) => a.startMs - b.startMs)
  const gaps: Range[] = []
  let t = 0
  for (const r of sorted) {
    if (r.startMs > t) gaps.push({ startMs: t, endMs: r.startMs })
    t = Math.max(t, r.endMs)
  }
  if (t < durationMs) gaps.push({ startMs: t, endMs: durationMs })
  if (gaps.length === 0) return null
  const focus = Math.max(0, Math.min(focusMs, durationMs))
  const gap = gaps.find((g) => g.endMs > focus) ?? gaps[0]!
  // Inside a gap: start at the playhead, unless that leaves a sliver before it.
  const inside = gap.startMs <= focus && focus < gap.endMs
  let start = inside ? focus : gap.startMs
  if (start - gap.startMs < MIN_REST_MS) start = gap.startMs
  let end = Math.min(gap.endMs, start + sizeMs)
  if (gap.endMs - end < MIN_REST_MS) end = gap.endMs
  return { startMs: start, endMs: end }
}

const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * Where the words already kept (`kept`, ending at the boundary) and a
 * neighbour's context words (`next`) say the same thing: the longest run at
 * the end of `kept` that also appears in `next`, near the boundary. Returns the
 * index in `next` just after that run, or -1.
 */
export function overlapEnd(kept: SpeechWord[], next: SpeechWord[], boundaryMs: number): number {
  const tail = kept.filter((w) => w.startMs >= boundaryMs - 2 * CONTEXT_MS)
  const head = next.filter((w) => w.startMs < boundaryMs + 2 * CONTEXT_MS)
  let best = { len: 0, end: -1 }
  for (let j = 0; j < head.length; j++) {
    // A run in `head` ending at j that equals the end of `tail`.
    let len = 0
    while (
      len < tail.length &&
      j - len >= 0 &&
      normWord(tail[tail.length - 1 - len]!.word) === normWord(head[j - len]!.word) &&
      normWord(head[j - len]!.word) !== ''
    )
      len++
    if (len === 0) continue
    const last = tail[tail.length - 1]!
    // One matching word is only trusted when it was heard at about the same time.
    const near = Math.abs(head[j]!.startMs - last.startMs) < 1200
    if ((len >= 2 || near) && len > best.len) best = { len, end: j + 1 }
  }
  return best.end === -1 ? -1 : next.indexOf(head[best.end - 1]!) + 1
}

/**
 * All words in media order. Pieces that touch are joined where their context
 * audio overlaps: the later piece continues after the words both heard, so a
 * word at the cut is neither doubled nor lost (the two passes time it a little
 * differently). Without a match, what the later piece heard after the last
 * word kept follows, minus a repeat of that word.
 */
export function composeWords(pieces: Piece[]): SpeechWord[] {
  const out: SpeechWord[] = []
  let prevEnd = -1
  for (const p of [...pieces].sort((a, b) => a.startMs - b.startMs)) {
    const touching = p.startMs === prevEnd && out.length > 0
    let add = p.words
    if (touching && p.heard?.length) {
      const at = overlapEnd(out, p.heard, p.startMs)
      if (at >= 0) add = p.heard.slice(at)
    }
    if (touching && add === p.words) {
      // No shared words (whisper drops words at the very edge of a clip): take
      // what this piece heard after the last word kept, even before its start.
      const lastEnd = out[out.length - 1]!.endMs
      add = (p.heard ?? p.words).filter((w) => w.startMs >= lastEnd - 50)
      if (add[0] && normWord(add[0].word) === normWord(out[out.length - 1]!.word))
        add = add.slice(1)
    }
    for (const w of add) {
      const prev = out[out.length - 1]
      // Keep media order: the two passes' clocks differ by a few hundred ms.
      const startMs = prev ? Math.max(w.startMs, prev.startMs + 1) : w.startMs
      out.push(
        startMs === w.startMs ? w : { ...w, startMs, endMs: Math.max(w.endMs, startMs + 10) },
      )
    }
    prevEnd = p.endMs
  }
  return out
}

/**
 * The quietest moment between `fromMs` and `toMs` of 10 ms frame levels (dB),
 * over a 200 ms window; among near-ties (1.5 dB), the one closest to `preferMs`.
 * Pieces are cut there: a clip that starts mid-sentence makes whisper skip that
 * sentence and stamp the next one from 0 (seen 3.3 s early at a 30 s cut).
 */
export function quietestMs(
  levels: Float32Array,
  fromMs: number,
  toMs: number,
  preferMs: number,
): number {
  const win = 20
  const a = Math.max(0, Math.floor(fromMs / 10))
  const b = Math.min(levels.length - win, Math.floor(toMs / 10))
  if (b <= a) return Math.max(fromMs, Math.min(toMs, preferMs))
  const avg: number[] = []
  let sum = 0
  for (let i = a; i < a + win; i++) sum += levels[i]!
  for (let i = a; i <= b; i++) {
    avg.push(sum / win)
    sum += (levels[i + win] ?? levels[i + win - 1]!) - levels[i]!
  }
  const min = Math.min(...avg)
  let best = -1
  for (let k = 0; k < avg.length; k++) {
    if (avg[k]! > min + 1.5) continue
    const ms = (a + k + win / 2) * 10
    if (best < 0 || Math.abs(ms - preferMs) < Math.abs(best - preferMs)) best = ms
  }
  return best
}

/** Merge touching ranges, for `coverage`. */
export function coverageOf(ranges: Range[]): Range[] {
  const out: Range[] = []
  for (const r of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    const last = out[out.length - 1]
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs)
    else out.push({ startMs: r.startMs, endMs: r.endMs })
  }
  return out
}

/** Same video, whatever the start-time or tracking parameters in its URL. */
export function canonicalPageUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl)
    u.hash = ''
    for (const p of ['t', 'start', 'time_continue', 'si', 'feature', 'pp', 'ab_channel'])
      u.searchParams.delete(p)
    return u.toString()
  } catch {
    return pageUrl
  }
}

function pcmFromWav(file: string): Int16Array {
  const buf = readFileSync(file)
  const at = buf.indexOf('data', 12)
  const data = at >= 0 ? buf.subarray(at + 8) : buf.subarray(44)
  const copy = Buffer.from(data.subarray(0, data.length - (data.length % 2)))
  return new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2)
}

export interface AheadDeps {
  models: ModelManager
  whisper: WhisperWorker
  gpu?: { use(kind: string): Promise<void> }
  ffmpeg: FfmpegBinaries
  ytDlp: string | null
  allowPrivateNetworks?: boolean
  /** The Player's relays: a saved copy is captioned instead of the page's link. */
  relays?: { localCopy(id: string): Download | null }
  /** Tests: skip the network. */
  resolve?: (req: UrlJob) => Promise<RemoteMedia>
  slice?: (
    media: RemoteMedia,
    out: string,
    startMs: number,
    durationMs: number,
    signal: AbortSignal,
  ) => Promise<void>
}

export interface AheadRunner extends JobRunner<UrlJob> {
  /** The viewer moved to `mediaMs` (seek): transcribe from there next. */
  focus(jobId: string, mediaMs: number): boolean
}

/**
 * `url` jobs (ADR-0020, Spec 08 §6): caption a page's video ahead of playback.
 * The engine fetches the audio itself, a piece at a time with Range requests,
 * starting at the playhead, so every caption exists before its moment and is
 * shown at its exact time. Then the rest of the video, for the full SRT.
 */
export function aheadRunner(deps: AheadDeps): AheadRunner {
  const focusOf = new Map<string, { ms: number; moved: boolean }>()

  /**
   * The relay's copy of the video, waiting while it is still being saved;
   * null without one (or when saving it failed), so the page's link is tried.
   */
  async function savedCopy(
    relayId: string,
    ctx: { signal: AbortSignal; progress(p: number, detail?: string): void },
  ): Promise<RemoteMedia | null> {
    for (;;) {
      const copy = deps.relays?.localCopy(relayId)
      if (!copy || copy.state === 'failed') return null
      if (copy.state === 'ready') {
        const { durationMs } = await probeMedia(deps.ffmpeg, copy.path, {}, ctx.signal)
        return durationMs
          ? { input: copy.path, headers: {}, durationMs, title: null, via: 'copy' }
          : null
      }
      ctx.progress(0, `saving the video (${Math.round(copy.progress * 100)} %)`)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 1000)
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new JobError('CANCELLED', 'cancelled'))
          },
          { once: true },
        )
      })
    }
  }

  return {
    type: 'url',
    gpu: true,
    // One page captioned at a time: a newer request replaces it.
    exclusive: {},

    focus(jobId, mediaMs) {
      const f = focusOf.get(jobId)
      if (!f) return false
      f.ms = mediaMs
      f.moved = true
      return true
    },

    validate(req) {
      if (!req.pageUrl || !/^https?:\/\//i.test(req.pageUrl))
        throw new JobError('JOB_INVALID', 'pageUrl must be an http(s) URL')
      if (req.relayId !== undefined && !/^[0-9a-f]{32}$/.test(req.relayId))
        throw new JobError('JOB_INVALID', 'relayId must be a relay id')
      if (
        req.cookiesFromBrowser !== undefined &&
        !(COOKIE_BROWSERS as readonly string[]).includes(req.cookiesFromBrowser)
      )
        throw new JobError(
          'JOB_INVALID',
          `unsupported cookiesFromBrowser '${req.cookiesFromBrowser}'`,
        )
      const entry = deps.models.entry(req.model)
      if (entry.role !== 'asr')
        throw new JobError('JOB_INVALID', `'${req.model}' is not a speech-recognition model`)
      const task = req.params?.task ?? 'transcribe'
      if (!entry.tasks?.includes(task))
        throw new JobError('JOB_INVALID', `'${req.model}' cannot ${task}`)
      if (req.params?.language && !isWhisperLanguage(req.params.language))
        throw new JobError('JOB_INVALID', `unsupported language '${req.params.language}'`)
      if (!deps.models.isInstalled(req.model)) {
        throw new JobError(
          'MODEL_NOT_INSTALLED',
          `model '${req.model}' is not installed — POST /v1/models/${req.model}/install`,
          false,
          409,
        )
      }
    },

    cacheKey(req) {
      return [
        'url',
        PIPELINE_VERSION,
        canonicalPageUrl(req.pageUrl),
        req.model,
        req.params?.task ?? 'transcribe',
        req.params?.language ?? 'auto',
        req.params?.bilingual ? 'bilingual' : '',
      ].join('|')
    },

    async run(req, ctx): Promise<RunOutput> {
      const task = req.params.task ?? 'transcribe'
      const focus = { ms: req.params.fromMs ?? 0, moved: true }
      focusOf.set(ctx.jobId, focus)
      try {
        ctx.progress(0, 'finding the audio')
        const began = Date.now()
        const copied = req.relayId ? await savedCopy(req.relayId, ctx) : null
        const media =
          copied ??
          (await (deps.resolve?.(req) ??
            resolveRemote(
              {
                ffmpeg: deps.ffmpeg,
                ytDlp: deps.ytDlp,
                allowPrivateNetworks: deps.allowPrivateNetworks ?? false,
                // A newer job (the viewer moved on) or a lost lease stops the fetch too.
                signal: ctx.signal,
              },
              req.pageUrl,
              req.mediaUrl,
              req.userAgent,
              req.cookiesFromBrowser,
            )))
        const slice =
          deps.slice ?? ((m, out, s, d, signal) => sliceRemote(deps.ffmpeg, m, out, s, d, signal))
        const resolvedAt = Date.now()
        ctx.progress(0, 'loading model')
        await deps.gpu?.use('asr')
        await deps.whisper.ensure(req.model, deps.models.pathOf(req.model))
        // Where the time to the first caption goes (Beta-1 checkpoint).
        ctx.log?.(
          'info',
          `url: audio found via ${media.via} in ${resolvedAt - began} ms, model ready after ${Date.now() - resolvedAt} ms`,
        )

        const total = media.durationMs
        const pieces: Piece[] = []
        /** Bilingual: the original's words per piece, next to the translation. */
        const bilingual = task === 'translate' && req.params.bilingual === true
        const originals: Piece[] = []
        let language = req.params.language ?? null

        const original = (draft: boolean): SubtitleTrack => {
          const source = language ?? 'und'
          return {
            id: newId(),
            projectId: '',
            language: source,
            title: media.title ?? source,
            kind: 'transcript',
            ...(draft ? { draft: true, coverage: coverageOf(pieces) } : {}),
            mediaDurationMs: total,
            cues: buildCuesFromWords(composeWords(originals)),
            createdAt: Date.now(),
          }
        }

        const track = (draft: boolean): SubtitleTrack => {
          const words = composeWords(pieces)
          const source = language ?? 'und'
          const translated = task === 'translate'
          const segmentCues = () =>
            cuesFromSegments(
              words.map((w) => ({ startMs: w.startMs, endMs: w.endMs, text: w.word })),
              7000,
            )
          return {
            id: newId(),
            projectId: '',
            language: translated ? 'en' : source,
            title: media.title ?? (translated ? 'English (Whisper)' : source),
            kind: translated ? 'translation' : 'transcript',
            ...(translated ? { derivedFrom: { sourceLanguage: source } } : {}),
            ...(draft ? { draft: true, coverage: coverageOf(pieces) } : {}),
            mediaDurationMs: total,
            cues: translated
              ? bilingual
                ? alignToWords(segmentCues(), composeWords(originals))
                : segmentCues()
              : buildCuesFromWords(words),
            createdAt: Date.now(),
          }
        }

        for (;;) {
          if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
          const size = focus.moved ? FIRST_PIECE_MS : PIECE_MS
          focus.moved = false
          const range = nextRange(pieces, total, focus.ms, size)
          if (!range || range.endMs <= range.startMs) break
          const done = pieces.reduce((n, p) => n + p.endMs - p.startMs, 0)
          ctx.progress(
            done / total,
            `captioning ${Math.round(range.startMs / 1000)}–${Math.round(range.endMs / 1000)} s`,
          )
          const before = pieces.find((p) => p.endMs === range.startMs)
          const after = pieces.some((p) => p.startMs === range.endMs)
          // Where nothing is transcribed yet, a cut can move to a pause instead of
          // splitting a sentence; next to an existing piece it stays put.
          const floor = Math.max(
            0,
            ...pieces.filter((p) => p.endMs <= range.startMs).map((p) => p.endMs),
          )
          const moveStart = !before && range.startMs > floor
          const moveEnd = !after && range.endMs < total
          const joinLead = before?.atPause ? PAUSE_LEAD_MS : CONTEXT_MS
          const from = moveStart
            ? Math.max(floor, range.startMs - SNAP_BACK_MS)
            : Math.max(0, range.startMs - joinLead)
          const to = Math.min(total, range.endMs + (moveEnd ? SNAP_MS : CONTEXT_MS))
          const file = join(ctx.chunkDir(), `${range.startMs}.wav`)
          let cut: Range = { ...range }
          let words: SpeechWord[] = []
          let heardWords: SpeechWord[] | undefined
          let originalWords: SpeechWord[] = []
          let originalHeard: SpeechWord[] = []
          const pieceAt = Date.now()
          let fetchedMs = 0
          try {
            await slice(media, file, from, to - from, ctx.signal)
            fetchedMs = Date.now() - pieceAt
            const pcm = pcmFromWav(file)
            // ffmpeg can exit cleanly after reading part of a stream (no Range
            // support, a dropped connection): never pass that off as silence.
            const gotMs = (pcm.length * 1000) / SAMPLE_RATE
            // The last piece may end early: audio can be shorter than the video.
            const wantMs = to - from
            const enough = to >= total ? Math.min(wantMs * 0.5, wantMs - 5000) : wantMs * 0.9 - 500
            if (gotMs < enough) {
              throw new JobError(
                'MEDIA_UNREACHABLE',
                `only ${Math.round(gotMs / 1000)} s of audio came back for ${Math.round(from / 1000)}–${Math.round(to / 1000)} s: the site may not allow fetching this video`,
                false,
                422,
              )
            }
            const levels = levelsFromPcm(pcm)
            const rel = (ms: number) => ms - from
            cut = {
              startMs: moveStart
                ? from + quietestMs(levels, 0, rel(range.startMs), rel(range.startMs))
                : range.startMs,
              endMs: moveEnd
                ? from +
                  quietestMs(
                    levels,
                    Math.max(rel(range.startMs) + 1000, rel(range.endMs) - SNAP_BACK_MS),
                    Math.min(gotMs, rel(to)) - 300,
                    rel(range.endMs),
                  )
                : range.endMs,
            }
            // What whisper hears: a little around cuts made in pauses, the join
            // context around cuts next to other pieces.
            const hearFrom = moveStart ? Math.max(from, cut.startMs - PAUSE_LEAD_MS) : from
            const hearTo = moveEnd ? Math.min(to, cut.endMs + PAUSE_LEAD_MS) : to
            const clip = pcm.subarray(
              Math.round((rel(hearFrom) * SAMPLE_RATE) / 1000),
              Math.round((rel(hearTo) * SAMPLE_RATE) / 1000),
            )
            if (levelDb(clip) >= SILENCE_DB) {
              const lead = leadingSilenceMs(clip)
              const heard = lead > 0 ? clip.subarray(Math.round((lead * SAMPLE_RATE) / 1000)) : clip
              const json = await deps.whisper.infer(wavBytes(heard), {
                language,
                translate: task === 'translate',
                prompt: promptFrom(before?.words.map((w) => w.word) ?? []),
                signal: ctx.signal,
              })
              language ??= whisperLanguageCode(json.detected_language ?? json.language)
              const raw =
                task === 'translate'
                  ? segmentsFromVerbose(json).map((s) => ({
                      word: s.text,
                      startMs: s.startMs,
                      endMs: s.endMs,
                    }))
                  : snapToOnsets(wordsFromVerbose(json), onsetsFromLevels(levelsFromPcm(heard)))
              const offset = hearFrom + lead
              const last = cut.endMs >= total
              // Media time, up to where the next piece begins; the context before
              // the start is kept apart (`heard`) for joining the previous piece.
              const placeAll = (list: SpeechWord[]) =>
                list
                  .map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset }))
                  .filter((w) => last || w.startMs < cut.endMs)
              const place = (list: SpeechWord[]) =>
                placeAll(list).filter((w) => w.startMs >= cut.startMs)
              words = place(raw)
              // Translations come as segments, too coarse to match: they keep the time rule.
              if (task !== 'translate') heardWords = placeAll(raw)
              if (bilingual) {
                // The English first (what the viewer is waiting for), then the original.
                pieces.push({ ...cut, words })
                ctx.partial(track(true), original(true))
                pieces.pop()
                // The same audio again, as a transcript: the words to learn from.
                const prior = originals.find((p) => p.endMs === range.startMs)
                const heardJson = await deps.whisper.infer(wavBytes(heard), {
                  language,
                  translate: false,
                  prompt: promptFrom(prior?.words.map((w) => w.word) ?? []),
                  signal: ctx.signal,
                })
                const originalRaw = snapToOnsets(
                  wordsFromVerbose(heardJson),
                  onsetsFromLevels(levelsFromPcm(heard)),
                )
                originalWords = place(originalRaw)
                originalHeard = placeAll(originalRaw)
              }
            }
          } finally {
            rmSync(file, { force: true })
          }
          ctx.log?.(
            'info',
            `url: piece ${Math.round(cut.startMs / 1000)}–${Math.round(cut.endMs / 1000)} s: audio in ${fetchedMs} ms, done in ${Date.now() - pieceAt} ms`,
          )
          const piece = { ...cut, atPause: moveEnd }
          pieces.push({ ...piece, words, ...(heardWords ? { heard: heardWords } : {}) })
          if (bilingual) originals.push({ ...piece, words: originalWords, heard: originalHeard })
          ctx.partial(track(true), bilingual ? original(true) : undefined)
        }
        ctx.progress(1, 'done')
        return {
          tracks: bilingual ? [track(false), original(false)] : [track(false)],
          ...(language ? { language } : {}),
        }
      } finally {
        focusOf.delete(ctx.jobId)
      }
    },
  }
}
