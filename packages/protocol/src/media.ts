import type { CookieBrowser } from './jobs'

/** Media upload / resolve / relay DTOs (Spec 03 §2, Spec 06 §4.1). */

export interface UploadResult {
  mediaHash: string // "sha256:…"
  durationMs: number
  normalizedBytes: number
}

/**
 * `POST /v1/media/resolve` (M05b): find a page video's playable stream (one
 * file with video and audio) and hand back a relay the Player's `<video>`
 * can play and seek.
 */
export interface MediaResolveRequest {
  /** The page (or embed) showing the video. */
  pageUrl: string
  /** The page `<video>`'s own src, when it is http(s). */
  mediaUrl?: string
  userAgent?: string
  cookiesFromBrowser?: CookieBrowser
}

export interface MediaResolveResponse {
  /** Unguessable, expiring relay id (6 h). */
  mediaId: string
  /** Path on the engine to play: `/v1/relay/<mediaId>` (no token needed). */
  relayPath: string
  durationMs: number | null
  title: string | null
  via: 'direct' | 'yt-dlp'
  /**
   * `ready`: play now. `downloading`: the site only serves separate video and
   * audio (YouTube), so the engine downloads and merges it first; poll
   * `GET /v1/media/relay/:mediaId` until `ready` ("Preparing media…").
   */
  state: RelayState
}

export type RelayState = 'ready' | 'downloading' | 'failed'

/** `GET /v1/media/relay/:mediaId`. */
export interface RelayStatusResponse {
  state: RelayState
  /** 0..1 while downloading. */
  progress: number
  error?: string
  /**
   * A streamed page video's copy on the engine, saved while the page's link
   * works (some links stop soon after their page stops playing). The relay
   * serves it once `ready`.
   */
  copy?: { state: RelayState; progress: number; error?: string }
}
