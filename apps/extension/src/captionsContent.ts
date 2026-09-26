import { browser } from 'wxt/browser'
import type { SubtitleTrack } from '@sublight/core'
import type { Message } from './messages'
import { isReady, type Range } from './coverage'
import { OverlayFrame } from './overlayFrame'

/** Pause playback where captions aren't ready yet, until they are (storage.local, default on). */
export const HOLD_KEY = 'holdPlayback'
const send = (msg: Message) => browser.runtime.sendMessage(msg).catch(() => {})

/**
 * Captions made ahead of playback, in the page (ADR-0020, Spec 09 §5a). The
 * track is already in media time, so it shows at its exact time: no delay.
 * Seeks go to the engine so the next piece starts at the new position. When
 * the playhead reaches a part that isn't captioned yet, playback holds there
 * ("Captioning this part…") and resumes by itself once it is; a user who
 * presses play anyway wins until the next seek.
 */
export class PageCaptions {
  private overlay: OverlayFrame
  private coverage: Range[] = []
  private final = false
  private hold = true
  private pausedByUs = false
  private resuming = false
  private userOverride = false
  private readonly events = [
    'seeked',
    'timeupdate',
    'play',
    'playing',
    'waiting',
    'durationchange',
    'emptied',
  ]
  private track: SubtitleTrack | null = null
  private hidden = false

  constructor(
    private readonly video: HTMLVideoElement,
    readonly jobId: string,
  ) {
    this.overlay = new OverlayFrame(video)
    this.overlay.setStatus('Captioning…')
    for (const e of this.events) video.addEventListener(e, this.onEvent)
    void browser.storage.local.get(HOLD_KEY).then((got) => {
      this.hold = got[HOLD_KEY] !== false
      this.check()
    })
  }

  get target(): HTMLVideoElement {
    return this.video
  }

  /**
   * Is the element playing something else right now? An ad on YouTube-like
   * players runs in the same <video> (its own src, length and clock): the
   * captions hide until the video is back. Leaving the video for good is a
   * URL change, which the content script handles.
   */
  private foreign(): boolean {
    const want = this.track?.mediaDurationMs
    const d = this.video.duration
    return !!want && Number.isFinite(d) && Math.abs(d * 1000 - want) > 1500
  }

  private onEvent = (e: Event) => {
    if (this.foreign()) {
      this.showForeign()
      return
    }
    if (this.hidden) {
      this.hidden = false
      if (this.track) this.overlay.setCues(this.track.cues, false, 0)
    }
    if (e.type === 'seeked') {
      this.userOverride = false
      void send({
        type: 'captions.seek',
        jobId: this.jobId,
        mediaMs: this.video.currentTime * 1000,
      })
    }
    if (e.type === 'play' && this.pausedByUs && !this.resuming) {
      // The viewer pressed play while we were holding: let them.
      this.userOverride = true
      this.pausedByUs = false
    }
    this.check()
  }

  private showForeign(): void {
    if (!this.hidden) {
      this.hidden = true
      this.overlay.setCues([], false, 0)
      this.overlay.setStatus(null)
    }
  }

  showTrack(track: SubtitleTrack, final: boolean): void {
    this.final = final
    this.track = track
    if (track.coverage) this.coverage = track.coverage
    if (this.foreign()) return this.showForeign()
    this.overlay.setCues(track.cues, false, 0)
    this.check()
  }

  private check(): void {
    if (this.hidden) return
    const v = this.video
    const duration = Number.isFinite(v.duration) ? v.duration * 1000 : null
    const ready = this.final || isReady(this.coverage, v.currentTime * 1000, duration)
    if (ready) {
      this.overlay.setStatus(null)
      if (this.pausedByUs) {
        this.pausedByUs = false
        this.resuming = true
        void v.play().finally(() => (this.resuming = false))
      }
      return
    }
    const holding = this.hold && !this.userOverride
    if (holding && !v.paused && !v.ended) {
      this.pausedByUs = true
      v.pause()
    }
    this.overlay.setStatus(
      holding ? 'Captioning this part… playback resumes by itself' : 'Captioning this part…',
    )
  }

  end(): void {
    for (const e of this.events) this.video.removeEventListener(e, this.onEvent)
    if (this.pausedByUs) void this.video.play().catch(() => {})
    this.pausedByUs = false
  }

  destroy(): void {
    this.end()
    this.overlay.destroy()
  }
}
