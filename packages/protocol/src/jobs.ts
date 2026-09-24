import type { SubtitleTrack } from '@sublight/core'
import type { JobState } from './events'

/**
 * Job API (Spec 03 §2). POST /v1/jobs bodies discriminated by `type`.
 */

export interface TranscribeParams {
  /** null = auto-detect. */
  language: string | null
  maxCueDurationMs: number
}

export interface TranscribeJob {
  type: 'transcribe'
  /** "sha256:…" or an uploaded mediaId. */
  mediaHash: string
  model: string
  params: TranscribeParams
}

export interface TranslateJob {
  type: 'translate'
  /** Cues + words inlined. */
  track: SubtitleTrack
  model: string
  targetLang: string
  glossary: { source: string; target: string }[]
  style: 'casual' | 'neutral' | 'formal'
}

export type JobCreation = TranscribeJob | TranslateJob

export interface JobSummary {
  id: string
  type: JobCreation['type']
  state: JobState
  progress: number // 0..1
  createdAt: number
  updatedAt: number
  error?: { code: string; message: string; retryable: boolean }
  partial?: SubtitleTrack
}

export interface JobFailure {
  retryable: boolean
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface JobResult {
  id: string
  state: 'done'
  tracks: SubtitleTrack[]
}
