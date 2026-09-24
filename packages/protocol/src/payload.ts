import type { OpenInPlayerSource } from '@sublight/core'

/**
 * "Open in Sublight Player" handoff payload (Spec 04 §9.1, ADR-0017).
 * Produced by the extension classifier, consumed by the player `/open` route.
 */
export interface OpenInPlayerPayload {
  version: 1
  source: { pageUrl: string; pageTitle?: string }
  media: {
    title?: string
    durationMs?: number
    isLive: boolean
    sources: OpenInPlayerSource[]
  }
  /** Prefer over ratio when known. */
  resumeAtMs?: number
  resumeAtRatio?: number
  requestedBy: 'popup' | 'overlay-chip' | 'context-menu'
}

/** Encode a payload into the `#sl=<base64url(json)>` hash (dev-player handoff). */
export function encodeOpenPayload(payload: OpenInPlayerPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('')
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a `#sl=` payload back into a typed object. Throws on invalid input. */
export function decodeOpenPayload(encoded: string): OpenInPlayerPayload {
  let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as OpenInPlayerPayload
  if (parsed.version !== 1 || !Array.isArray(parsed.media?.sources))
    throw new Error('invalid open-in-player payload')
  return parsed
}
