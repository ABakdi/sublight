import { create } from 'zustand'
import type { SubtitleTrack } from '@sublight/core'
import type { AsrTask, JobCreation, JobResult, JobSummary, WsEvent } from '@sublight/protocol'
import { chooseTranslationPath } from '@sublight/protocol'
import { engine, EngineError } from '../lib/engine'
import { socket, useEngineStore } from './engine'
import { usePlayerStore } from './player'

export type CaptionPhase =
  'idle' | 'uploading' | 'queued' | 'transcribing' | 'done' | 'cancelled' | 'error'

export interface CaptionRequest {
  model: string
  /** null = auto-detect. */
  language: string | null
  task: AsrTask
}

export type Activity = 'caption' | 'translate'

export interface TranslateOptions {
  targetLang: string
  style: 'casual' | 'neutral' | 'formal'
  glossary: { source: string; target: string }[]
}

export interface CaptionError {
  code: string
  message: string
}

interface CaptionState {
  phase: CaptionPhase
  /** 0..1 within the phase (bytes while uploading, job progress after). */
  progress: number
  detail: string | null
  jobId: string | null
  /** Progressive draft track (`job.partial`), shown until the final one lands. */
  draft: SubtitleTrack | null
  error: CaptionError | null
  /** Summary of the last finished run. */
  resultNote: string | null
  /** What the current/last run does, and for translations which track it started from. */
  activity: Activity
  sourceTrackId: string | null
  start: (req: CaptionRequest) => Promise<void>
  /** Translate a track (Spec 07 §2.0 routing: English from audio via Whisper, else the LLM). */
  translate: (sourceTrackId: string, opts: TranslateOptions) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const POLL_MS = 1500

function resultNote(track: SubtitleTrack, result: JobResult, cached: boolean): string {
  const parts = [`${track.cues.length} cues`, track.language]
  const low = result.translation?.lowConfidenceCues ?? 0
  if (low) parts.push(`${low} to review`)
  if (cached) parts.push('from cache')
  else if (result.realtimeFactor) parts.push(`${(1 / result.realtimeFactor).toFixed(1)}× realtime`)
  else if (result.translation?.tokensPerSecond)
    parts.push(`${result.translation.tokensPerSecond} tokens/s`)
  return parts.join(' · ')
}

/** Plain-language messages for engine error codes (Spec 04 §5.3). */
export function describeError(err: unknown): CaptionError {
  if (!(err instanceof EngineError)) {
    return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
  }
  const messages: Record<string, string> = {
    OFFLINE: 'The engine isn’t running. Start it with `pnpm dev:engine`, then try again.',
    UNAUTHORIZED:
      'The engine rejected the saved token. Paste the current one (`pnpm engine:token`).',
    AUDIO_EMPTY: 'This video’s audio is silent, so there is nothing to transcribe.',
    AUDIO_UNSUPPORTED: 'The engine found no audio track it can read in this file.',
    MEDIA_TOO_LARGE: 'The file is larger than the engine’s upload limit.',
    MODEL_NOT_INSTALLED: 'That model isn’t installed yet. Install it, then try again.',
    WORKER_UNAVAILABLE:
      'The speech engine (whisper-server) couldn’t start. Build it once with `pnpm engine:setup-whisper`.',
  }
  return { code: err.code, message: messages[err.code] ?? err.message }
}

/**
 * The "Caption this video" flow (Spec 04 §5, M03.2-M03.3): upload (skipped
 * when the engine still has this project's audio) → transcribe job → drafts
 * stream in over WS → the final track replaces them in the project. WS is an
 * accelerator; job state is polled over REST as the source of truth.
 */
export const useCaptionStore = create<CaptionState>((set, get) => {
  let abort: AbortController | null = null
  let stopWatching: (() => void) | null = null

  const finish = (patch: Partial<CaptionState>) => {
    stopWatching?.()
    stopWatching = null
    abort = null
    set(patch)
  }

  const applySummary = (job: JobSummary) => {
    if (job.id !== get().jobId) return
    if (job.state === 'queued') set({ phase: 'queued', detail: 'waiting for the GPU' })
    else if (job.state === 'running') {
      set({ phase: 'transcribing', progress: job.progress, detail: job.detail ?? null })
    }
  }

  const watch = (jobId: string): Promise<JobSummary> =>
    new Promise((resolve, reject) => {
      let settled = false
      const settle = (job: JobSummary) => {
        if (settled) return
        if (['done', 'failed', 'cancelled'].includes(job.state)) {
          settled = true
          resolve(job)
        } else applySummary(job)
      }
      const onEvent = (e: WsEvent) => {
        if (!('jobId' in e) || e.jobId !== jobId) return
        if (e.type === 'job.progress') {
          set({ phase: 'transcribing', progress: e.progress, detail: e.detail ?? get().detail })
        } else if (e.type === 'job.partial') {
          set({ draft: e.draft })
        } else if (e.type === 'job.state') {
          void engine.job(jobId).then(settle, () => {})
        }
      }
      const off = socket.on(onEvent)
      socket.subscribe(jobId)
      const timer = setInterval(() => {
        engine.job(jobId).then(settle, (err: unknown) => {
          if (err instanceof EngineError && err.code !== 'OFFLINE') {
            settled = true
            reject(err)
          }
        })
      }, POLL_MS)
      stopWatching = () => {
        off()
        clearInterval(timer)
      }
    })

  const begin = (activity: Activity, sourceTrackId: string | null = null) => {
    abort = new AbortController()
    set({
      activity,
      sourceTrackId,
      phase: 'uploading',
      progress: 0,
      detail: null,
      jobId: null,
      draft: null,
      error: null,
      resultNote: null,
    })
  }

  const fail = (err: unknown) => {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return finish({ phase: 'cancelled', detail: null })
    }
    finish({ phase: 'error', error: describeError(err), detail: null })
  }

  /** The engine's copy of this project's audio; uploads only when it has none (AC4). */
  const ensureMedia = async (): Promise<string> => {
    const project = usePlayerStore.getState().project!
    let mediaHash = project.media.mediaHash ?? null
    if (mediaHash && !(await engine.mediaInfo(mediaHash))) mediaHash = null
    if (mediaHash) return mediaHash
    const file = usePlayerStore.getState().videoFile
    if (!file) {
      throw new EngineError('NO_FILE', 'Open the video file again so it can be sent to the engine.')
    }
    set({ phase: 'uploading', detail: `sending ${file.name}` })
    const uploaded = await engine.uploadMedia(file, project.id, {
      signal: abort!.signal,
      onProgress: (sent, total) => set({ progress: total ? sent / total : 0 }),
    })
    await usePlayerStore.getState().setMediaHash(uploaded.mediaHash)
    return uploaded.mediaHash
  }

  /** Create the job, follow it, and add its track to the project. */
  const runJob = async (body: JobCreation, source?: SubtitleTrack) => {
    set({ phase: 'queued', progress: 0, detail: 'starting' })
    const job = await engine.createJob(body, crypto.randomUUID())
    set({ jobId: job.id })
    const final = ['done', 'failed', 'cancelled'].includes(job.state) ? job : await watch(job.id)
    if (final.state === 'cancelled') return finish({ phase: 'cancelled', detail: null })
    if (final.state === 'failed') {
      throw new EngineError(
        final.error?.code ?? 'JOB_FAILED',
        final.error?.message ?? 'The job failed.',
      )
    }
    const result = await engine.result(final.id)
    const track = result.tracks[0]
    if (!track) throw new EngineError('JOB_FAILED', 'The engine returned no track.')
    // A translation always points back at the track it came from (bilingual pairing).
    const added = source
      ? { ...track, derivedFrom: { trackId: source.id, sourceLanguage: source.language } }
      : track
    await usePlayerStore.getState().addGeneratedTrack(added)
    finish({
      phase: 'done',
      progress: 1,
      draft: null,
      detail: null,
      resultNote: resultNote(added, result, final.cached === true),
    })
  }

  return {
    activity: 'caption',
    sourceTrackId: null,
    phase: 'idle',
    progress: 0,
    detail: null,
    jobId: null,
    draft: null,
    error: null,
    resultNote: null,

    start: async (req) => {
      if (!usePlayerStore.getState().project) return
      begin('caption')
      try {
        const mediaHash = await ensureMedia()
        await runJob({
          type: 'transcribe',
          mediaHash,
          model: req.model,
          params: { language: req.language, task: req.task, maxCueDurationMs: 7000 },
        })
      } catch (err) {
        fail(err)
      }
    },

    translate: async (sourceTrackId, opts) => {
      const project = usePlayerStore.getState().project
      const source = project?.tracks.find((t) => t.id === sourceTrackId)
      if (!project || !source) return
      begin('translate', sourceTrackId)
      try {
        const models = useEngineStore.getState().models
        const whisperModel = models.find(
          (m) => m.role === 'asr' && m.installed && m.tasks?.includes('translate'),
        )
        // Audio is available when the engine still has it or the file is open.
        const hasAudio =
          whisperModel !== undefined &&
          (usePlayerStore.getState().videoFile !== null ||
            (project.media.mediaHash !== undefined &&
              (await engine.mediaInfo(project.media.mediaHash)) !== null))
        const path = chooseTranslationPath({
          targetLang: opts.targetLang,
          hasAudio,
          wantsGlossaryOrStyle: opts.glossary.length > 0 || opts.style !== 'neutral',
        })
        if (path === 'whisper-translate' && whisperModel) {
          // English from the audio itself (ADR-0018): no LLM needed.
          const mediaHash = await ensureMedia()
          await runJob(
            {
              type: 'transcribe',
              mediaHash,
              model: whisperModel.id,
              params: { language: source.language, task: 'translate', maxCueDurationMs: 7000 },
            },
            source,
          )
          return
        }
        const llm = models.find((m) => m.role === 'translate' && m.installed)
        if (!llm) {
          throw new EngineError('MODEL_NOT_INSTALLED', 'Install the translation model first.')
        }
        set({ phase: 'queued', detail: 'starting' })
        await runJob(
          {
            type: 'translate',
            // Word timings aren't needed to translate and would bloat the request.
            track: { ...source, cues: source.cues.map(({ words: _w, ...c }) => c) },
            model: llm.id,
            targetLang: opts.targetLang,
            glossary: opts.glossary,
            style: opts.style,
          },
          source,
        )
      } catch (err) {
        fail(err)
      }
    },

    cancel: async () => {
      const { jobId, phase } = get()
      abort?.abort()
      if (jobId && (phase === 'queued' || phase === 'transcribing')) {
        try {
          await engine.cancelJob(jobId)
        } catch {
          // the poll loop reports whatever state the engine ends in
        }
      }
    },

    reset: () => {
      stopWatching?.()
      stopWatching = null
      set({
        activity: 'caption',
        sourceTrackId: null,
        phase: 'idle',
        progress: 0,
        detail: null,
        jobId: null,
        draft: null,
        error: null,
        resultNote: null,
      })
    },
  }
})
