/**
 * The nouns of sublight — the authoritative data model (Spec 02 §1).
 * Pure structural types; validation lives in `validation.ts`.
 *
 * All time values are INTEGER MILLISECONDS. No floats on the wire.
 */

/** Word-level atom from ASR/alignment (Spec 02 §1). */
export interface SpeechWord {
  word: string
  startMs: number
  endMs: number
  /** 0..1, optional. */
  confidence?: number
}

/** One subtitle entry. */
export interface SubtitleCue {
  id: string // UUID
  startMs: number
  endMs: number
  /** May contain newlines = multiple rendered lines. */
  text: string
  /** Present when ASR produced word timestamps. */
  words?: SpeechWord[]
  /** From [SPEAKER] markers or future diarization. */
  speaker?: string | null
  /** Per-cue overrides (rare). */
  style?: Partial<SubtitleStyle>
  /** Translation couldn't be mapped 1:1 and was re-split by duration (Spec 07 §2.3). */
  lowConfidence?: boolean
}

export type TrackKind = 'transcript' | 'translation' | 'import'

export interface SubtitleTrack {
  id: string
  projectId: string
  /** BCP-47, e.g. "en", "pt-BR". */
  language: string
  /** Optional human label, e.g. "English (AI)". */
  title?: string
  kind: TrackKind
  /**
   * For translations: source language, plus the source track when translated
   * from one (LLM). Whisper `translate` works from audio, so no trackId (ADR-0018).
   */
  derivedFrom?: { trackId?: string; sourceLanguage: string }
  /** True while live captions are replacing; never both draft and final. */
  draft?: boolean
  /** Drafts made ahead of playback (ADR-0020): media ranges already transcribed. */
  coverage?: { startMs: number; endMs: number }[]
  /** Length of the media the track was made from, when known (ADR-0020). */
  mediaDurationMs?: number
  cues: SubtitleCue[]
  /** Track-level style (defaults to the user global). */
  style?: SubtitleStyle
  /** Whole-track nudge (δ or manual), ms. */
  syncOffsetMs?: number
  createdAt: number // epoch ms
}

export type MediaKind = 'local-file' | 'page-video'
export type MediaTransport = 'direct' | 'hls' | 'dash' | 'engine-relay' | 'none'

export type OpenInPlayerSourceKind =
  | 'https-direct' // plain media file -> play directly
  | 'hls' // .m3u8 -> hls.js
  | 'dash' // .mpd -> dash.js
  | 'engine-fetchable' // blob:/MSE, site supported by the engine relay (yt-dlp)
  | 'blob-mse' // blob:/MSE, not transferable -> cannot migrate
  | 'live' // video.isLive — playback only, transcription deferred

/** Mirror of the extension classifier's output (Spec 02 §1 / 09 §8.2). */
export interface OpenInPlayerSource {
  kind: OpenInPlayerSourceKind
  url: string
  mime?: string
  quality?: string
  canPlayDirectly?: boolean
}

export interface SubtitleProjectMedia {
  kind: MediaKind
  /** File name / page URL. */
  source?: string
  durationMs?: number
  /** Engine normalized-audio hash (transcription cache key). */
  mediaHash?: string
  // --- page-video only (opened via open-in-player, ADR-0017) ---
  pageUrl?: string
  pageTitle?: string
  sources?: OpenInPlayerSource[]
  transport?: MediaTransport
  /** Effective playback URL (may be an engine relay URL). */
  directUrl?: string
  /** Engine media id when relayed. */
  relayId?: string
  /** Position migrated mid-play. */
  resumeAtMs?: number
}

export interface SubtitleProject {
  id: string
  title: string
  media: SubtitleProjectMedia
  tracks: SubtitleTrack[]
  settings: {
    activeTrackId?: string
    bilingual?: { sourceTrackId: string; translationTrackId: string } | null
    /** Fixed translations for names and terms, sent with LLM translate jobs (Spec 07 §2.2). */
    glossary?: { source: string; target: string }[]
    /** User-global style (player + extension share the schema). */
    style: SubtitleStyle
  }
  updatedAt: number
}

/**
 * Style schema — serialized as CSS custom-property values (Spec 02 §6,
 * Spec 05). Defaults in `defaults.ts`; the overlay maps it to `--sl-*` vars.
 */
export interface SubtitleStyle {
  /** #RRGGBB. */
  color: string
  /** Supports transparent via opacity. */
  bgColor: string
  /** 0..1. */
  bgOpacity: number
  /** px at reference video height 720, scaled with video. */
  fontSize: number
  /** CSS font stack. */
  fontFamily: string
  fontWeight: number | 'normal' | 'bold'
  /** Adds outline for contrast. */
  textShadow: boolean
  edgeStyle: 'none' | 'outline' | 'shadow' | 'raised'
  align: 'left' | 'center' | 'right'
  position: {
    anchor:
      | 'bottom'
      | 'top'
      | 'left'
      | 'right'
      | 'bottom-left'
      | 'bottom-right'
      | 'top-left'
      | 'top-right'
    marginPx: number
  }
  /** 1..4 (dictates pre-wrap). */
  maxLines: number
  /** Multiplier. */
  lineHeight: number
  /** word = hard wrap by word count (default). */
  wrapStyle: 'smart' | 'word'
  /** 0..1 whole-cue opacity. */
  opacity: number
  casing: 'normal' | 'uppercase' | 'title'
  // study mode (M09)
  karaoke?: { active: boolean; highlightColor: string; lagMs: number }
  bilingual?: { secondaryColor: string; secondaryOpacity: number; heightRatio: number }
}
