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

export const JOB_STATES: readonly JobState[] = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
]
