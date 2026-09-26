/** Options: hide the site's own captions while sublight's are showing (default on). */
export const HIDE_SITE_CAPTIONS_KEY = 'hideSiteCaptions'

/** Caption layers of common players, drawn in the page rather than as text tracks. */
export const SITE_CAPTION_SELECTORS = [
  '.ytp-caption-window-container', // YouTube
  '.caption-window', // YouTube (older)
  '.vp-captions', // Vimeo
  '.jw-captions', // JW Player
  '.vjs-text-track-display', // Video.js
  '.plyr__captions', // Plyr
  '.shaka-text-container', // Shaka
  '.dmp_SubtitleView', // Dailymotion
]

const STYLE_ID = 'sublight-hide-site-captions'

/**
 * While sublight's captions are on, the site's own would sit on top of them
 * (YouTube's CC, a `<track>` the page enabled). Hide both, and put them back
 * exactly as they were afterwards.
 */
export class SiteCaptions {
  private saved = new Map<TextTrack, TextTrackMode>()
  private hidden = false

  constructor(private readonly video: HTMLVideoElement) {}

  hide(): void {
    if (this.hidden) return
    this.hidden = true
    // Native text tracks: 'hidden' keeps cue events for the page, draws nothing.
    for (const track of Array.from(this.video.textTracks ?? [])) {
      if (track.mode === 'showing') {
        this.saved.set(track, track.mode)
        track.mode = 'hidden'
      }
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `${SITE_CAPTION_SELECTORS.join(',\n')} { display: none !important; }`
      document.documentElement.append(style)
    }
  }

  show(): void {
    if (!this.hidden) return
    this.hidden = false
    for (const [track, mode] of this.saved) track.mode = mode
    this.saved.clear()
    document.getElementById(STYLE_ID)?.remove()
  }
}
