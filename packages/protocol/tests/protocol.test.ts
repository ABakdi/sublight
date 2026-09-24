import { describe, expect, it } from 'vitest'
import {
  decodeOpenPayload,
  encodeOpenPayload,
  PROTOCOL_VERSION,
  ERROR_CODES,
  type OpenInPlayerPayload,
} from '../src/index'

const payload: OpenInPlayerPayload = {
  version: 1,
  source: { pageUrl: 'https://example.com/watch/1', pageTitle: 'Example' },
  media: {
    isLive: false,
    durationMs: 120_000,
    sources: [{ kind: 'hls', url: 'https://cdn.example.com/master.m3u8' }],
  },
  requestedBy: 'popup',
}

describe('protocol package', () => {
  it('declares protocol version 1 and a constrained error-code set', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(ERROR_CODES).toContain('UNAUTHORIZED')
    expect(ERROR_CODES).toContain('GPU_OOM')
  })

  it('round-trips the open-in-player payload through base64url', () => {
    const encoded = encodeOpenPayload(payload)
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
    const decoded = decodeOpenPayload(encoded)
    expect(decoded).toEqual(payload)
  })

  it('rejects a malformed payload', () => {
    expect(() => decodeOpenPayload(encodeOpenPayload(payload).replace(/^./, 'A'))).toThrow()
  })
})
