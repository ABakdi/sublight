// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { videoKey, videoPageUrl } from './videos'

describe('the page of the playing video', () => {
  it('finds a feed item’s own link, not the next item’s', () => {
    document.body.innerHTML = `
      <div class="feed">
        <article><video id="a"></video><a href="/@maker/video/111">clip a</a></article>
        <article><video id="b"></video><a href="/@other/video/222">clip b</a></article>
      </div>`
    const b = document.getElementById('b')!
    expect(videoPageUrl(b, 'https://www.tiktok.com/foryou')).toBe(
      'https://www.tiktok.com/@other/video/222',
    )
  })
  it('keeps a page that already is one video, and other sites as they are', () => {
    document.body.innerHTML = '<video id="v"></video>'
    const v = document.getElementById('v')!
    expect(videoPageUrl(v, 'https://www.instagram.com/reel/Abc_1/')).toBe(
      'https://www.instagram.com/reel/Abc_1/',
    )
    expect(videoPageUrl(v, 'https://www.youtube.com/shorts/xyz')).toBe(
      'https://www.youtube.com/shorts/xyz',
    )
  })
  it('treats a start-time change as the same video', () => {
    expect(videoKey('https://www.youtube.com/watch?v=abc&t=120s')).toBe(
      videoKey('https://www.youtube.com/watch?v=abc'),
    )
    expect(videoKey('https://www.youtube.com/watch?v=abc')).not.toBe(
      videoKey('https://www.youtube.com/watch?v=def'),
    )
  })
})
