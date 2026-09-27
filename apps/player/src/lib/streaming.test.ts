// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { attachStream } from './streaming'

describe('attaching an HLS stream', () => {
  it('a stale cleanup never undoes a newer attachment (effects run twice in dev)', async () => {
    const video = document.createElement('video')
    video.canPlayType = () => 'maybe' // native HLS, like Safari or recent Chromium
    const url = 'https://cdn.test/master.m3u8'
    const first = attachStream(video, url, 'hls', () => {})
    const second = attachStream(video, url, 'hls', () => {})
    ;(await first)() // the first effect's cleanup lands last
    expect(video.getAttribute('src')).toBe(url)
    ;(await second)()
    expect(video.getAttribute('src')).toBeNull()
  })
})
