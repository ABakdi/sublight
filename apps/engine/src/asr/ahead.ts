import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildCuesFromWords, newId, type SpeechWord, type SubtitleTrack } from '@sublight/core'
import { COOKIE_BROWSERS, type UrlJob } from '@sublight/protocol'
import { JobError, type JobRunner, type RunOutput } from '../jobs/queue'
import { levelDb, SAMPLE_RATE, wavBytes } from '../live/session'
import type { FfmpegBinaries } from '../media/ffmpeg'
import { resolveRemote, sliceRemote, type RemoteMedia } from '../media/remote'
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
/** Audio fetched around a piece for context; its words belong to the neighbours. */
const CONTEXT_MS = 1000
/** Don't leave a sliver this short to a later piece. */
const MIN_REST_MS = 10_000
/** Bump when output changes for the same input, so stale cache entries miss. */
const PIPELINE_VERSION = 2

export interface Range {
  startMs: number
  endMs: number
}

export interface Piece extends Range {
  words: SpeechWord[]
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

/**
 * All words in media order. Where a piece starts right where another ended,
 * words the earlier one already has (heard in its context audio) are dropped.
 */
export function composeWords(pieces: Piece[]): SpeechWord[] {
  const out: SpeechWord[] = []
  let prevEnd = -1
  for (const p of [...pieces].sort((a, b) => a.startMs - b.startMs)) {
    const lastEnd = p.startMs === prevEnd ? (out[out.length - 1]?.endMs ?? -1) : -1
    for (const w of p.words) if (w.startMs >= lastEnd - 50) out.push(w)
    prevEnd = p.endMs
  }
  return out
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
  /** Tests: skip the network. */
  resolve?: (req: UrlJob) => Promise<RemoteMedia>
  slice?: (media: RemoteMedia, out: string, startMs: number, durationMs: number) => Promise<void>
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
      ].join('|')
    },

    async run(req, ctx): Promise<RunOutput> {
      const task = req.params.task ?? 'transcribe'
      const focus = { ms: req.params.fromMs ?? 0, moved: true }
      focusOf.set(ctx.jobId, focus)
      try {
        ctx.progress(0, 'finding the audio')
        const media = await (deps.resolve?.(req) ??
          resolveRemote(
            { ffmpeg: deps.ffmpeg, ytDlp: deps.ytDlp },
            req.pageUrl,
            req.mediaUrl,
            req.userAgent,
            req.cookiesFromBrowser,
          ))
        const slice = deps.slice ?? ((m, out, s, d) => sliceRemote(deps.ffmpeg, m, out, s, d))
        ctx.progress(0, 'loading model')
        await deps.gpu?.use('asr')
        await deps.whisper.ensure(req.model, deps.models.pathOf(req.model))

        const total = media.durationMs
        const pieces: Piece[] = []
        let language = req.params.language ?? null

        const track = (draft: boolean): SubtitleTrack => {
          const words = composeWords(pieces)
          const source = language ?? 'und'
          const translated = task === 'translate'
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
              ? cuesFromSegments(
                  words.map((w) => ({ startMs: w.startMs, endMs: w.endMs, text: w.word })),
                  7000,
                )
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
          const from = Math.max(0, range.startMs - CONTEXT_MS)
          const to = Math.min(total, range.endMs + CONTEXT_MS)
          const file = join(ctx.chunkDir(), `${range.startMs}.wav`)
          let words: SpeechWord[] = []
          try {
            await slice(media, file, from, to - from)
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
            if (levelDb(pcm) >= SILENCE_DB) {
              const lead = leadingSilenceMs(pcm)
              const heard = lead > 0 ? pcm.subarray(Math.round((lead * SAMPLE_RATE) / 1000)) : pcm
              const before = pieces.find((p) => p.endMs === range.startMs)
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
              const offset = from + lead
              const last = range.endMs >= total
              words = raw
                .map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset }))
                .filter((w) => w.startMs >= range.startMs && (last || w.startMs < range.endMs))
            }
          } finally {
            rmSync(file, { force: true })
          }
          pieces.push({ ...range, words })
          ctx.partial(track(true))
        }
        ctx.progress(1, 'done')
        return { tracks: [track(false)], ...(language ? { language } : {}) }
      } finally {
        focusOf.delete(ctx.jobId)
      }
    },
  }
}
