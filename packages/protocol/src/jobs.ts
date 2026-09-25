import type { SubtitleTrack } from '@sublight/core'
import type { JobState } from './events'

export type JobPriority = 'interactive' | 'batch'

/**
 * Job API (Spec 03 §2). POST /v1/jobs bodies discriminated by `type`.
 */

/**
 * Whisper task (ADR-0018): `translate` = any spoken language → English text,
 * timed from segments. Only multilingual checkpoints support it.
 */
export type AsrTask = 'transcribe' | 'translate'

export interface TranscribeParams {
  /** Source language; null = auto-detect. */
  language: string | null
  /** Defaults to `transcribe`. */
  task?: AsrTask
  maxCueDurationMs: number
}

export interface TranscribeJob {
  type: 'transcribe'
  /** "sha256:…" or an uploaded mediaId. */
  mediaHash: string
  model: string
  params: TranscribeParams
  /** Live captions are `interactive`; files default to `batch`. */
  priority?: JobPriority
}

export interface TranslateJob {
  type: 'translate'
  /** Cues + words inlined. */
  track: SubtitleTrack
  model: string
  targetLang: string
  glossary: { source: string; target: string }[]
  style: 'casual' | 'neutral' | 'formal'
  priority?: JobPriority
}

export type JobCreation = TranscribeJob | TranslateJob

export interface JobSummary {
  id: string
  type: JobCreation['type']
  state: JobState
  progress: number // 0..1
  /** Human-readable phase, e.g. "loading model", "transcribing". */
  detail?: string
  priority: JobPriority
  /** Set when the result came from the cache (same media + model + params). */
  cached?: boolean
  createdAt: number
  updatedAt: number
  error?: JobFailure
  partial?: SubtitleTrack
}

export interface JobListResponse {
  jobs: JobSummary[]
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
  /** Transcribe jobs: detected (or requested) source language. */
  language?: string
  /** Wall-clock ASR time / audio duration (lower is faster). */
  realtimeFactor?: number
}
