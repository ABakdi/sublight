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

/**
 * Live captioning from captured audio (Spec 08 §5, M05). The job runs until
 * stopped: the client streams audio to `POST /v1/live/:jobId/audio`, reports
 * playback changes to `/anchor`, and ends it with `/stop`, which triggers the
 * refinement pass. Drafts arrive as `job.partial`, already in media time.
 */
export interface LiveJob {
  type: 'live'
  model: string
  params: {
    language: string | null
    task?: AsrTask
    /** Model for the refinement pass on stop (default: the live model). A fast
     * live model + an accurate refine model keeps drafts quick and the result good. */
    refineModel?: string
  }
  priority?: JobPriority
}

/**
 * Maps capture time to media time (Spec 08 §4): from `wallMs` on, the video
 * is at `mediaMs` and advances at `rate` while `playing`. Sent on start,
 * play, pause, seek and rate changes.
 */
export interface LiveAnchor {
  wallMs: number
  mediaMs: number
  rate: number
  playing: boolean
}

/** Engine-side view of a live session, in `GET /v1/live/:jobId`. */
export interface LiveStatus {
  jobId: string
  receivedMs: number
  /** How far behind real time the transcription is, ms. */
  lagMs: number
  committedWords: number
  stopping: boolean
}

export type JobCreation = TranscribeJob | TranslateJob | LiveJob

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
  /** Translate jobs (LLM path). */
  translation?: {
    paragraphs: number
    /** Cues re-split by duration because the model's line count didn't match. */
    lowConfidenceCues: number
    tokensPerSecond: number | null
  }
}
