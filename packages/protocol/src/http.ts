/** Health & meta endpoints (Spec 03 §2). */

export interface GpuInfo {
  available: boolean
  name: string | null
  vramTotal: number | null // MB
  vramFree: number | null // MB
}

export interface HealthResponse {
  status: 'online'
  version: string
  engineUptimeMs: number
  gpu: GpuInfo
  activeJobs: number
  /** Jobs waiting for a slot. */
  queuedJobs?: number
  /** Model loaded in the ASR worker, if any. */
  residentModel?: string | null
  /** Normalized-audio cache size, bytes. */
  mediaCacheBytes?: number
  /** Simple counters feeding checkpoints (Spec 06 §8). */
  metrics?: {
    jobsTotal: number
    jobsDone: number
    jobsFailed: number
    avgAsrRealtimeFactor: number | null
    avgTranslationTokPerSec: number | null
  }
}

export interface VersionResponse {
  engine: string // semver
  protocol: number
}

export type ModelState = 'not-installed' | 'downloading' | 'installed' | 'error'

export interface ModelInfo {
  id: string
  role: 'asr' | 'translate'
  /** ASR models: supported Whisper tasks (ADR-0018). */
  tasks?: ('transcribe' | 'translate')[]
  name: string
  sizeBytes: number | null
  vramClass: string | null
  license: string
  installed: boolean
  state: ModelState
  progress: number | null // 0..1 while downloading
  diskUsedBytes?: number
  /** Last install error, when state is `error`. */
  error?: string
}

export interface ModelsResponse {
  models: ModelInfo[]
  /** Disk used by installed models, bytes. */
  diskUsedBytes: number
}

/** Error envelope (Spec 03 §6). */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'BAD_ORIGIN',
  'MODEL_NOT_INSTALLED',
  'MODEL_INSTALL_FAILED',
  'MEDIA_TOO_LARGE',
  'AUDIO_EMPTY',
  'AUDIO_UNSUPPORTED',
  'JOB_NOT_FOUND',
  'JOB_INVALID',
  'JOB_FAILED',
  'WORKER_UNAVAILABLE',
  'GPU_OOM',
  'INTERNAL',
  'MEDIA_UNRESOLVABLE',
  'MEDIA_UNREACHABLE',
  'NOT_FOUND',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ApiError {
  code: ErrorCode
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface ErrorEnvelope {
  error: ApiError
}

export interface PairInfoResponse {
  requiresToken: boolean
  /** Short-lived pairing nonce when the token isn't set (M06 pairing flow). */
  nonce?: string
  expiresAtMs?: number
}
