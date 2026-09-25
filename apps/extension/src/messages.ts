import type { SubtitleTrack } from '@sublight/core'
import type { LiveAnchor } from '@sublight/protocol'

/**
 * Runtime messages between content script, service worker, offscreen
 * document and popup (Spec 09 §6).
 */

/** What a frame reports about its videos (Spec 09 §4.3). */
export interface VideoState {
  frame: 'top' | 'iframe'
  url: string
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

export type Message =
  | { type: 'video.state'; state: VideoState }
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
