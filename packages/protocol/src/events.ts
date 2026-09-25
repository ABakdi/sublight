import type { SubtitleTrack } from '@sublight/core'
import type { ModelState } from './http'

/** WS event envelope (Spec 03 §4). */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface WsEventJobState {
  type: 'job.state'
  jobId: string
  state: JobState
}
export interface WsEventJobProgress {
  type: 'job.progress'
  jobId: string
  progress: number // 0..1
  detail?: string
}
export interface WsEventJobPartial {
  type: 'job.partial'
  jobId: string
  draft: SubtitleTrack
}
export interface WsEventJobLog {
  type: 'job.log'
  jobId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}
export interface WsEventModelInstallProgress {
  type: 'model.install.progress'
  modelId: string
  progress: number
}
export interface WsEventModelState {
  type: 'model.state'
  modelId: string
  state: ModelState
}
export interface WsEventEngineGpu {
  type: 'engine.gpu'
  vramFree: number
  residentModel: string | null
}
/** Relay buffering progress (Spec 06 §4.1). */
export interface WsEventRelayProgress {
  type: 'relay.progress'
  mediaId: string
  progress: number
}

export type WsEvent =
  | WsEventJobState
  | WsEventJobProgress
  | WsEventJobPartial
  | WsEventJobLog
  | WsEventModelInstallProgress
  | WsEventModelState
  | WsEventEngineGpu
  | WsEventRelayProgress

/**
 * Client → engine WS messages (Spec 03 §4). The first message must be `auth`
 * or the socket is closed within 1 s. Without `subscribe`, a client receives
 * every event; with it, only events for the listed jobs (plus engine/model events).
 */
export type WsClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; jobIds: string[] }
  | { type: 'unsubscribe'; jobIds: string[] }

/** Engine → client control replies (not part of the event stream). */
export type WsControlMessage =
  { type: 'auth.ok'; protocol: number } | { type: 'error'; code: string; message: string }

export const JOB_STATES: readonly JobState[] = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
]
