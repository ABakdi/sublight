import { create } from 'zustand'
import type { SubtitleTrack } from '@sublight/core'
import type { AsrTask, JobSummary, WsEvent } from '@sublight/protocol'
import { engine, EngineError } from '../lib/engine'
import { socket } from './engine'
import { usePlayerStore } from './player'

export type CaptionPhase =
  'idle' | 'uploading' | 'queued' | 'transcribing' | 'done' | 'cancelled' | 'error'

export interface CaptionRequest {
  model: string
  /** null = auto-detect. */
  language: string | null
  task: AsrTask
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
  start: (req: CaptionRequest) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const POLL_MS = 1500

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
    MODEL_NOT_INSTALLED: 'That model isn’t installed yet. Install it above, then caption again.',
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

  return {
    phase: 'idle',
    progress: 0,
    detail: null,
    jobId: null,
    draft: null,
    error: null,
    resultNote: null,

    start: async (req) => {
      const player = usePlayerStore.getState()
      const project = player.project
      if (!project) return
      abort = new AbortController()
      set({
        phase: 'uploading',
        progress: 0,
        detail: null,
        jobId: null,
        draft: null,
        error: null,
        resultNote: null,
      })
      try {
        // 1. Audio: reuse the engine's copy when it still has it (AC4: no re-upload).
        let mediaHash = project.media.mediaHash ?? null
        if (mediaHash && !(await engine.mediaInfo(mediaHash))) mediaHash = null
        if (!mediaHash) {
          const file = usePlayerStore.getState().videoFile
          if (!file) {
            throw new EngineError(
              'NO_FILE',
              'Open the video file again so it can be sent to the engine.',
            )
          }
          set({ detail: `sending ${file.name}` })
          const uploaded = await engine.uploadMedia(file, project.id, {
            signal: abort.signal,
            onProgress: (sent, total) => set({ progress: total ? sent / total : 0 }),
          })
          mediaHash = uploaded.mediaHash
          await usePlayerStore.getState().setMediaHash(mediaHash)
        }

        // 2. Job.
        set({ phase: 'queued', progress: 0, detail: 'starting' })
        const job = await engine.createJob(
          {
            type: 'transcribe',
            mediaHash,
            model: req.model,
            params: { language: req.language, task: req.task, maxCueDurationMs: 7000 },
          },
          crypto.randomUUID(),
        )
        set({ jobId: job.id })
        const final = ['done', 'failed', 'cancelled'].includes(job.state)
          ? job
          : await watch(job.id)

        if (final.state === 'cancelled') return finish({ phase: 'cancelled', detail: null })
        if (final.state === 'failed') {
          throw new EngineError(
            final.error?.code ?? 'JOB_FAILED',
            final.error?.message ?? 'The job failed.',
          )
        }

        // 3. Result → project.
        const result = await engine.result(final.id)
        const track = result.tracks[0]
        if (!track) throw new EngineError('JOB_FAILED', 'The engine returned no track.')
        await usePlayerStore.getState().addGeneratedTrack(track)
        const speed = result.realtimeFactor
          ? ` · ${(1 / result.realtimeFactor).toFixed(1)}× realtime`
          : ''
        finish({
          phase: 'done',
          progress: 1,
          draft: null,
          detail: null,
          resultNote: `${track.cues.length} cues · ${track.language}${final.cached ? ' · from cache' : speed}`,
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return finish({ phase: 'cancelled', detail: null })
        }
        finish({ phase: 'error', error: describeError(err), detail: null })
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
