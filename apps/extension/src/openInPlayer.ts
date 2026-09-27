import { browser } from 'wxt/browser'
import type { OpenInPlayerSource } from '@sublight/core'
import {
  encodeOpenPayload,
  PLAYER_DEFAULT_PORT,
  type CookieBrowser,
  type OpenInPlayerPayload,
} from '@sublight/protocol'
import { COOKIES_KEY } from './prefs'
import type { Message, VideoState } from './messages'

/** Options: where the Sublight Player runs (the one the engine serves by default; dev: :5173). */
export const PLAYER_URL_KEY = 'playerUrl'
export const DEFAULT_PLAYER_URL = `http://127.0.0.1:${PLAYER_DEFAULT_PORT}/`

/**
 * What the page's video is, for the Player (Spec 09 §8.2): its own file, an
 * HLS/DASH manifest, or something only the engine can fetch (blob:/MSE:
 * YouTube, Vimeo…), in which case the page URL is what the engine resolves.
 */
export function classifySources(state: VideoState): OpenInPlayerSource[] {
  const p = state.primary
  const pageUrl = p?.pageUrl ?? state.url
  if (p?.isLive) return [{ kind: 'live', url: pageUrl }]
  const src = p?.src
  if (src) {
    const path = src.split(/[?#]/)[0]!.toLowerCase()
    if (path.endsWith('.m3u8')) return [{ kind: 'hls', url: src }]
    if (path.endsWith('.mpd')) return [{ kind: 'dash', url: src }]
    return [{ kind: 'https-direct', url: src, canPlayDirectly: true }]
  }
  return [{ kind: 'engine-fetchable', url: pageUrl }]
}

function playhead(v: VideoState): number {
  const p = v.primary!
  return p.isPlaying
    ? p.currentTimeMs + (Date.now() - v.reportedAt) * p.playbackRate
    : p.currentTimeMs
}

/** The handoff for the Player's `#sl=` route. */
export function buildPayload(
  state: VideoState,
  title: string,
  cookiesFromBrowser?: CookieBrowser,
): OpenInPlayerPayload {
  const p = state.primary!
  return {
    version: 1,
    source: { pageUrl: p.pageUrl ?? state.url, ...(title ? { pageTitle: title } : {}) },
    media: {
      ...(title ? { title } : {}),
      ...(p.durationMs !== null ? { durationMs: p.durationMs } : {}),
      isLive: p.isLive,
      sources: classifySources(state),
    },
    resumeAtMs: Math.round(playhead(state)),
    requestedBy: 'popup',
    engine: {
      userAgent: navigator.userAgent,
      ...(cookiesFromBrowser ? { cookiesFromBrowser } : {}),
    },
  }
}

/**
 * "Open in Sublight Player" (M05b): pause the video on its page (so it isn't
 * heard twice) and open the Player on it, at the same moment.
 */
export async function openInPlayer(
  tabId: number,
  owner: { frameId: number; state: VideoState },
): Promise<{ ok: boolean; error?: string }> {
  if (!owner.state.primary) return { ok: false, error: 'No video on this page.' }
  if (owner.state.primary.isLive)
    return { ok: false, error: 'This is a live stream: it can only be captioned on its page.' }
  const prefs = await browser.storage.local.get([PLAYER_URL_KEY, COOKIES_KEY])
  const base = ((prefs[PLAYER_URL_KEY] as string | undefined) || DEFAULT_PLAYER_URL).replace(
    /#.*$/,
    '',
  )
  const tab = await browser.tabs.get(tabId).catch(() => null)
  const title = owner.state.title || tab?.title || ''
  const payload = buildPayload(
    owner.state,
    title,
    (prefs[COOKIES_KEY] as CookieBrowser | undefined) || undefined,
  )
  await browser.tabs
    .sendMessage(tabId, { type: 'video.pause' } satisfies Message, { frameId: owner.frameId })
    .catch(() => {})
  await browser.tabs.create({ url: `${base}#sl=${encodeOpenPayload(payload)}` })
  return { ok: true }
}
