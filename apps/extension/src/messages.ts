import type { CaptionMode, SubtitleTrack } from '@sublight/core'
import type { LiveAnchor } from '@sublight/protocol'

/**
 * Runtime messages between content script, service worker, offscreen
 * document and popup (Spec 09 §6).
 */

/** What a frame reports about its videos (Spec 09 §4.3). */
export interface VideoState {
  frame: 'top' | 'iframe'
  url: string
  /** document.title of the frame (the top frame's names the video on most sites). */
  title: string
  videoCount: number
  /** The primary video: playing + visible beats paused; larger beats smaller. */
  primary: {
    isPlaying: boolean
    currentTimeMs: number
    /** null while unknown or for live streams. */
    durationMs: number | null
    playbackRate: number
    width: number
    height: number
    /** The element's own media URL when it is http(s) (not blob:/MSE). */
    src: string | null
    /** This video's own page when the page is a feed of many (TikTok, Reels), else the page URL. */
    pageUrl: string
  } | null
  demoCaptions: boolean
  /** Epoch ms of this snapshot; with playbackRate it extrapolates the playhead. */
  reportedAt: number
}

export type EngineStatus =
  | { state: 'online'; version: string; protocol: number }
  | { state: 'no-token' }
  | { state: 'unauthorized' }
  | { state: 'refused'; detail: string }
  | { state: 'offline'; detail: string }

export interface TabStatus {
  tabId: number
  /** One entry per frame that has reported, top frame first. */
  frames: VideoState[]
}

/** Where live audio comes from (Spec 08 §1): the element itself, or the whole tab. */
export type CaptureSource = 'element' | 'tab'

/** One tab's live-captioning session, kept by the SW in storage.session. */
export interface LiveState {
  tabId: number
  jobId: string
  source: CaptureSource | null
  phase: 'starting' | 'listening' | 'refining' | 'done' | 'error' | 'stopped'
  detail?: string
  error?: string
  /** Something the user should act on while listening (muted, no sound). */
  notice?: string
  cues: number
}

/**
 * One tab's captions made ahead of playback (ADR-0020), kept by the SW in
 * storage.session. The engine fetches the audio itself and transcribes
 * ahead of the playhead; `coverage` is what's already captioned.
 */
export interface CaptionsState {
  tabId: number
  jobId: string
  phase: 'starting' | 'captioning' | 'done' | 'error' | 'stopped'
  detail?: string
  error?: string
  /** The engine can't reach this video's audio: live captions are the way. */
  suggestLive?: boolean
  /** 0..1 of the whole video. */
  progress: number
  coverage: { startMs: number; endMs: number }[]
  title?: string
  /** A download waits for the whole video, in this mode. */
  pendingDownload?: CaptionMode
}

export type Message =
  | { type: 'video.state'; state: VideoState }
  // popup → SW: captions ahead of playback (ADR-0020)
  | { type: 'captions.start'; tabId: number }
  | { type: 'captions.stop'; tabId: number }
  | { type: 'captions.status'; tabId: number }
  /** Save the whole video's captions as SRT (transcribing the rest first if needed). */
  | { type: 'captions.download'; tabId: number; mode: CaptionMode }
  // SW → content
  | { type: 'captions.begin'; jobId: string }
  /** `companion`: the original, when `track` is a translation (bilingual display). */
  | { type: 'captions.track'; track: SubtitleTrack; final: boolean; companion?: SubtitleTrack }
  | { type: 'captions.end' }
  /** A line for the quick controls ("Translating to French… 40 %"), null clears it. */
  | { type: 'captions.ui'; note: string | null }
  // content → SW
  | { type: 'captions.seek'; jobId: string; mediaMs: number }
  /** The viewer picked another language in the quick controls ('original' or a code). */
  | { type: 'captions.translate'; jobId: string; target: string }
  /** Captions are on and another video took over (feed scroll, next video): caption it. */
  | { type: 'captions.next'; state: VideoState }
  | { type: 'captions.navigated'; jobId: string }
  // popup → SW
  | { type: 'live.start'; tabId: number }
  | { type: 'live.stop'; tabId: number }
  | { type: 'live.status'; tabId: number }
  // SW → content
  | { type: 'live.begin'; jobId: string; captureElement: boolean }
  | { type: 'live.end' }
  | { type: 'live.track'; track: SubtitleTrack; final: boolean }
  | { type: 'live.notice'; message: string | null }
  // content / offscreen → SW
  | { type: 'live.audio'; jobId: string; wallMs: number; pcm: string }
  | { type: 'live.anchor'; jobId: string; anchor: LiveAnchor }
  | { type: 'live.fallback'; jobId: string; reason: string }
  /** The page moved to another video (SPA navigation, new src): end without showing results. */
  | { type: 'live.navigated'; jobId: string }
  /** A user-facing hint from the page or offscreen ("unmute the video"), null clears it. */
  | { type: 'live.hint'; jobId: string; message: string | null }
  /** The page with captions is unloading (reload, navigation, close): cancel its jobs. */
  | { type: 'page.gone' }
  // SW → offscreen
  | { type: 'offscreen.start'; jobId: string; streamId: string }
  | { type: 'offscreen.stop' }
  | { type: 'engine.status' }
  | { type: 'tab.status'; tabId: number }
  | { type: 'demo.toggle'; tabId: number; on: boolean }
  | { type: 'demo.set'; on: boolean }
  | { type: 'ping' }

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as Message).type === 'string'
}
