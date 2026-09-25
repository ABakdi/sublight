import { buildCuesFromWords, newId, type SpeechWord, type SubtitleTrack } from '@sublight/core'
import type { LiveJob } from '@sublight/protocol'
import { isWhisperLanguage, whisperLanguageCode } from '../asr/languages'
import { cuesFromSegments } from '../asr/segments'
import { mergeWords, planChunks, promptFrom } from '../asr/transcribe'
import { levelsFromPcm, onsetsFromLevels, snapToOnsets } from '../asr/onsets'
import type { WhisperWorker } from '../asr/whisper'
import { segmentsFromVerbose, wordsFromVerbose, type VerboseJson } from '../asr/words'
import { JobError, type JobRunner, type RunContext, type RunOutput } from '../jobs/queue'
import { SILENCE_DB } from '../media/store'
import type { ModelManager } from '../models/manager'
import type { GpuResidency } from '../workers/gpu'
import type { LiveHub } from './hub'
import { levelDb, SAMPLE_RATE, splitStable, wavBytes, type LiveSession } from './session'

export interface LiveOptions {
  /** How often the rolling window is transcribed. */
  stepMs: number
  /** The newest audio whisper may still revise; words older than this commit. */
  holdMs: number
  /** Longest window sent to whisper (its native context is 30 s). */
  maxWindowMs: number
  /** Minimum new audio before another pass. */
  minNewMs: number
  /** No audio for this long ends the session (tab closed, extension reloaded). */
  idleTimeoutMs: number
}

export const LIVE_DEFAULTS: LiveOptions = {
  stepMs: 1500,
  holdMs: 3000,
  maxWindowMs: 28_000,
  minNewMs: 1000,
  idleTimeoutMs: 60_000,
}

export interface LiveDeps {
  models: ModelManager
  whisper: WhisperWorker
  gpu: GpuResidency
  hub: LiveHub
  options?: Partial<LiveOptions>
}

const samples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000)

/**
 * Add words for a media-time range, replacing what was there: after a seek
 * back, the re-watched stretch is transcribed again and the new words win.
 */
export function mergeByMediaRange(existing: SpeechWord[], incoming: SpeechWord[]): SpeechWord[] {
  if (incoming.length === 0) return existing
  const from = incoming[0]!.startMs
  const to = incoming[incoming.length - 1]!.endMs
  return [...existing.filter((w) => w.endMs <= from || w.startMs >= to), ...incoming].sort(
    (a, b) => a.startMs - b.startMs,
  )
}

/**
 * `live` jobs (Spec 08 §5, M05): transcribe captured audio as it arrives. A
 * rolling window (≤ 28 s from the last committed word) goes through whisper
 * every 1.5 s; words older than 3 s commit, the rest are drafts. Words are
 * mapped to media time through the client's playback anchors, so pauses,
 * seeks and speed changes stay in sync. On stop, each contiguous playing
 * stretch is transcribed again with full context (the refinement pass) and
 * kept unless it lost words.
 */
export function liveRunner(deps: LiveDeps): JobRunner<LiveJob> {
  const opt = { ...LIVE_DEFAULTS, ...deps.options }

  /** Whisper output for one window → words relative to it, starts snapped to energy onsets. */
  const toWords = (
    json: VerboseJson,
    task: 'transcribe' | 'translate',
    pcm: Int16Array,
  ): SpeechWord[] =>
    task === 'translate'
      ? segmentsFromVerbose(json).map((s) => ({ word: s.text, startMs: s.startMs, endMs: s.endMs }))
      : snapToOnsets(wordsFromVerbose(json), onsetsFromLevels(levelsFromPcm(pcm)))

  function track(
    words: SpeechWord[],
    req: LiveJob,
    language: string | null,
    draft: boolean,
  ): SubtitleTrack {
    const source = language ?? 'und'
    const translated = req.params.task === 'translate'
    return {
      id: newId(),
      projectId: '',
      language: translated ? 'en' : source,
      title: translated ? 'English (live, Whisper)' : `${source} (live)`,
      kind: translated ? 'translation' : 'transcript',
      ...(translated ? { derivedFrom: { sourceLanguage: source } } : {}),
      ...(draft ? { draft: true } : {}),
      cues: translated
        ? cuesFromSegments(
            words.map((w) => ({ startMs: w.startMs, endMs: w.endMs, text: w.word })),
            7000,
          )
        : buildCuesFromWords(words),
      createdAt: Date.now(),
    }
  }

  /** The refinement pass over one playing stretch, chunked like file jobs. */
  async function refineSegment(
    session: LiveSession,
    seg: { from: number; to: number },
    req: LiveJob,
    language: string | null,
    signal: AbortSignal,
  ): Promise<SpeechWord[]> {
    const task = req.params.task ?? 'transcribe'
    const out: SpeechWord[] = []
    for (const chunk of planChunks(((seg.to - seg.from) * 1000) / SAMPLE_RATE)) {
      const from = seg.from + samples(chunk.startMs)
      const pcm = session.read(from, Math.min(seg.to, from + samples(chunk.sliceMs)))
      if (levelDb(pcm) < SILENCE_DB) continue
      const json = await deps.whisper.infer(wavBytes(pcm), {
        language,
        translate: task === 'translate',
        signal,
      })
      const words = toWords(json, task, pcm).map((w) => ({
        ...w,
        startMs: w.startMs + chunk.startMs,
        endMs: w.endMs + chunk.startMs,
      }))
      mergeWords(
        out,
        words,
        chunk.endMs === ((seg.to - seg.from) * 1000) / SAMPLE_RATE ? Infinity : chunk.endMs,
      )
    }
    return session.toMedia(out, seg.from)
  }

  return {
    type: 'live',
    gpu: true,

    validate(req) {
      const entry = deps.models.entry(req.model)
      if (entry.role !== 'asr')
        throw new JobError('JOB_INVALID', `'${req.model}' is not a speech-recognition model`)
      const task = req.params?.task ?? 'transcribe'
      if (!entry.tasks?.includes(task))
        throw new JobError('JOB_INVALID', `'${req.model}' cannot ${task}`)
      if (req.params?.language && !isWhisperLanguage(req.params.language)) {
        throw new JobError('JOB_INVALID', `unsupported language '${req.params.language}'`)
      }
      if (!deps.models.isInstalled(req.model)) {
        throw new JobError(
          'MODEL_NOT_INSTALLED',
          `model '${req.model}' is not installed — POST /v1/models/${req.model}/install`,
          false,
          409,
        )
      }
    },

    // Every capture is unique audio.
    cacheKey: () => null,

    async run(req, ctx: RunContext): Promise<RunOutput> {
      const task = req.params.task ?? 'transcribe'
      const session = deps.hub.get(ctx.jobId)
      try {
        ctx.progress(0, 'loading model')
        await deps.gpu.use('asr')
        await deps.whisper.ensure(req.model, deps.models.pathOf(req.model))
        ctx.progress(0, 'listening')

        let language = req.params.language ?? null
        let windowStart = 0
        let committed: SpeechWord[] = []
        let lastRunAt = 0
        // Only re-run when new audio arrived since the last pass (not just since the window start).
        let lastRunEnd = 0

        for (;;) {
          if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
          if (Date.now() - session.lastAudioAt > opt.idleTimeoutMs) session.stopping = true
          const available = session.totalSamples - windowStart
          const fresh = session.totalSamples - lastRunEnd
          const due = Date.now() - lastRunAt >= opt.stepMs
          if (session.stopping && available < samples(300)) break
          if (!session.stopping && (!due || fresh < samples(opt.minNewMs))) {
            await new Promise((r) => setTimeout(r, 100))
            continue
          }
          lastRunAt = Date.now()
          const end = session.totalSamples
          lastRunEnd = end
          const pcm = session.read(windowStart, end)
          const windowMs = (pcm.length * 1000) / SAMPLE_RATE
          if (levelDb(pcm) < SILENCE_DB) {
            windowStart = end // silence (or a paused video): nothing to hear
            continue
          }
          const json = await deps.whisper.infer(wavBytes(pcm), {
            language,
            translate: task === 'translate',
            prompt: promptFrom(committed.map((w) => w.word)),
            signal: ctx.signal,
          })
          language ??= whisperLanguageCode(json.detected_language ?? json.language)
          // Commit everything when stopping or when the window is about full.
          const final = session.stopping || windowMs >= opt.maxWindowMs
          const { committed: stable, tentative } = splitStable(
            toWords(json, task, pcm),
            windowMs,
            final ? 0 : opt.holdMs,
          )
          committed = mergeByMediaRange(committed, session.toMedia(stable, windowStart))
          const draft = session.toMedia(tentative, windowStart)
          // A final pass committed everything it heard: the whole window is consumed.
          if (final) windowStart = end
          else if (stable.length) windowStart += samples(stable[stable.length - 1]!.endMs)
          ctx.partial(track(mergeByMediaRange(committed, draft), req, language, true))
          const lag = Date.now() - session.wallAt(end)
          ctx.progress(0, `live · ${Math.max(0, Math.round(lag / 1000))} s behind`)
        }

        // Refinement pass (Spec 07 §1.5): full context per playing stretch.
        const segments = session.playingSegments()
        let refined: SpeechWord[] = []
        for (let i = 0; i < segments.length; i++) {
          ctx.progress(i / Math.max(1, segments.length), 'refining')
          refined = mergeByMediaRange(
            refined,
            await refineSegment(session, segments[i]!, req, language, ctx.signal),
          )
        }
        // Never regress (Spec 07 §1.5): keep the live words if refinement lost many.
        const words = refined.length >= committed.length * 0.8 ? refined : committed
        return { tracks: [track(words, req, language, false)], ...(language ? { language } : {}) }
      } finally {
        deps.hub.close(ctx.jobId)
      }
    },
  }
}
