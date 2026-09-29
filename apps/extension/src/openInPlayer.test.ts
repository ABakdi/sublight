import { describe, expect, it } from 'vitest'
import { classifySources, openInPlayer } from './openInPlayer'
import type { VideoState } from './messages'

const state = (src: string | null, durationMs: number | null = 60_000): VideoState => ({
  frame: 'top',
  url: 'https://site.test/watch',
  title: 'Clip',
  videoCount: 1,
  primary: {
    isPlaying: true,
    currentTimeMs: 1000,
    durationMs,
    playbackRate: 1,
    width: 640,
    height: 360,
    src,
    pageUrl: 'https://site.test/watch?v=1',
    isLive: durationMs === Infinity,
  },
  demoCaptions: false,
  reportedAt: 0,
})

describe('what the page video is, for the Player', () => {
  it('plays its own file, or hands manifests and blob players over', () => {
    expect(classifySources(state('https://cdn.test/a.mp4?sig=1'))[0]).toMatchObject({
      kind: 'https-direct',
      url: 'https://cdn.test/a.mp4?sig=1',
    })
    expect(classifySources(state('https://cdn.test/master.m3u8'))[0]!.kind).toBe('hls')
    expect(classifySources(state('https://cdn.test/v.mpd'))[0]!.kind).toBe('dash')
    // blob:/MSE (YouTube): the engine resolves the video's page.
    expect(classifySources(state(null))[0]).toEqual({
      kind: 'engine-fetchable',
      url: 'https://site.test/watch?v=1',
    })
    expect(classifySources(state(null, Infinity))[0]!.kind).toBe('live')
    // Not loaded yet is not live: an HLS page whose length isn't known yet.
    expect(classifySources(state('https://cdn.test/master.m3u8', null))[0]!.kind).toBe('hls')
  })
})

describe('what never moves to the Player (M05b AC5)', () => {
  it('refuses a live stream, and a page without a video, with the reason', async () => {
    const live = await openInPlayer(1, { frameId: 0, state: state(null, Infinity) })
    expect(live).toEqual({ ok: false, error: expect.stringMatching(/live stream/) })
    const none = await openInPlayer(1, { frameId: 0, state: { ...state(null), primary: null } })
    expect(none).toEqual({ ok: false, error: 'No video on this page.' })
  })
})

describe('the Player address (security review R9)', () => {
  it('is one on this computer, or the default', async () => {
    const { playerUrl } = await import('./openInPlayer')
    expect(playerUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(playerUrl('http://127.0.0.1:17420/#sl=old')).toBe('http://127.0.0.1:17420/')
    for (const bad of [
      'https://evil.test/',
      'http://evil.test:17420/',
      'javascript:alert(1)',
      'http://u:p@127.0.0.1/',
      42,
      '',
    ])
      expect(playerUrl(bad)).toBe('http://127.0.0.1:17420/')
  })
})
