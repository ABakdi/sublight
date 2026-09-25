/**
 * Runtime messages between content script, service worker and popup
 * (Spec 09 §6). Only the slice needed before capture lands (M05) lives here.
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

export type Message =
  | { type: 'video.state'; state: VideoState }
  | { type: 'engine.status' }
  | { type: 'tab.status'; tabId: number }
  | { type: 'demo.toggle'; tabId: number; on: boolean }
  | { type: 'demo.set'; on: boolean }
  | { type: 'ping' }

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as Message).type === 'string'
}
