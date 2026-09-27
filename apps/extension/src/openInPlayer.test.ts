import { describe, expect, it } from 'vitest'
import { classifySources } from './openInPlayer'
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
    expect(classifySources(state(null, null))[0]!.kind).toBe('live')
  })
})
