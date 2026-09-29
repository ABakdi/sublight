import type { SubtitleTrack } from '@sublight/core'
import { EngineSocket, WS_BASE_URL, type JobResult, type JobSummary } from '@sublight/protocol'
import { bestEffort, engineRequest, getToken } from './engine'
import { TARGETS } from './quickControls'

/** The LLM translator for targets other than English (ADR-0018/0019). */
export const TRANSLATE_MODEL = 'qwen3-4b-instruct'

/** How often a leased job hears from us (the engine cancels it after 90 s of silence). */
export const KEEPALIVE_MS = 30_000

export const languageName = (code: string) => TARGETS.find(([c]) => c === code)?.[1] ?? code

/** A job that ended without a result: failed (with the engine's message) or cancelled. */
export class JobEnded extends Error {
  constructor(
    readonly state: 'failed' | 'cancelled',
    message: string,
  ) {
    super(message)
  }
}

export interface FollowedJob {
  /** The result once the job is done; rejects with `JobEnded` otherwise. */
  done: Promise<JobResult>
  /** Stop following; `done` rejects as cancelled (the job itself runs on unless cancelled). */
  close(): void
}

/**
 * Follow one engine job on its own WebSocket until it ends, renewing its
 * lease meanwhile. Partial tracks and progress go to the callbacks.
 */
export function followJob(
  jobId: string,
  on: { partial?: (track: SubtitleTrack) => void; progress?: (progress: number) => void } = {},
): FollowedJob {
  let socket: EngineSocket | null = null
  let settled = false
  let rejectDone: (err: Error) => void = () => {}
  const keepalive = setInterval(() => {
    void engineRequest(`/v1/jobs/${jobId}/keepalive`, { method: 'POST' }).catch(
      bestEffort('keepalive'),
    )
  }, KEEPALIVE_MS)
  const stop = () => {
    settled = true
    clearInterval(keepalive)
    socket?.close()
    socket = null
  }
  const done = new Promise<JobResult>((resolve, reject) => {
    rejectDone = reject
    const end = async (state: JobSummary['state']) => {
      if (settled) return
      if (state === 'done') {
        const result = await engineRequest<JobResult>(`/v1/jobs/${jobId}/result`).catch(
          (err: unknown) => err,
        )
        stop()
        if (result instanceof Error) reject(result)
        else resolve(result as JobResult)
      } else if (state === 'failed' || state === 'cancelled') {
        const job = await engineRequest<JobSummary>(`/v1/jobs/${jobId}`).catch(() => null)
        stop()
        reject(new JobEnded(state, job?.error?.message ?? state))
      }
    }
    socket = new EngineSocket({
      url: () => `${WS_BASE_URL}/ws`,
      token: getToken,
      // Missed while disconnected, or finished before we subscribed (a cached translation).
      onReconnect: () => void check(),
      onError: (err) => {
        if (settled) return
        stop()
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    })
    socket.on((e) => {
      if (!('jobId' in e) || e.jobId !== jobId) return
      if (e.type === 'job.partial') on.partial?.(e.draft)
      else if (e.type === 'job.progress') on.progress?.(e.progress)
      else if (e.type === 'job.state') return end(e.state)
    })
    socket.subscribe(jobId)
    const check = () =>
      engineRequest<JobSummary>(`/v1/jobs/${jobId}`)
        .then((job) => end(job.state))
        .catch(() => {})
    void socket.connect().then(check)
  })
  const close = () => {
    if (settled) return
    stop()
    rejectDone(new JobEnded('cancelled', 'no longer followed'))
  }
  return { done, close }
}
