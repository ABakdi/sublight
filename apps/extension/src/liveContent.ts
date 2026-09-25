import { browser } from 'wxt/browser'
import type { SubtitleTrack } from '@sublight/core'
import type { LiveAnchor } from '@sublight/protocol'
import { startPcmCapture, type PcmCapture } from './capture'
import type { Message } from './messages'
import { OverlayFrame } from './overlayFrame'
import { levelDb, pcmToBase64 } from './pcm'

/** Element audio silent this long while the video plays → it's tainted/DRM: use tabCapture. */
const SILENT_FALLBACK_MS = 4000
const SILENCE_DB = -60
/** Cap and headroom for the live display delay. */
const MAX_LAG_MS = 8000
const LAG_MARGIN_MS = 500

const send = (msg: Message) => browser.runtime.sendMessage(msg).catch(() => {})

/**
 * The in-page half of live captioning (Spec 08 §1, §4; Spec 09 §5): reports
 * playback anchors for the engine's capture → media timeline, captures the
 * element's own audio when it is CORS-clean (`captureStream`, no prompt),
 * asks the SW to fall back to tabCapture when that audio stays silent, and
 * renders the live track over the video.
 */
export class LiveSession {
  private overlay: OverlayFrame
  private capture: PcmCapture | null = null
  private silentMs = 0
  private fellBack = false
  private readonly events = ['play', 'playing', 'pause', 'waiting', 'seeked', 'ratechange', 'ended']

  constructor(
    private readonly video: HTMLVideoElement,
    readonly jobId: string,
    /** Called when the element switches to another source (a new video). */
    private readonly onSourceChange: () => void = () => {},
  ) {
    this.overlay = new OverlayFrame(video)
    for (const e of this.events) video.addEventListener(e, this.onPlayback)
    video.addEventListener('emptied', this.onEmptied)
    this.sendAnchor()
  }

  private onEmptied = () => this.onSourceChange()

  /** Last hint sent, so it goes out only on change. */
  private hint: string | null = null
  private setHint(message: string | null): void {
    if (message === this.hint) return
    this.hint = message
    void send({ type: 'live.hint', jobId: this.jobId, message })
  }

  get target(): HTMLVideoElement {
    return this.video
  }

  /** Where the video is now; waiting (buffering) counts as not playing. */
  private anchorNow(): LiveAnchor {
    const v = this.video
    return {
      wallMs: Date.now(),
      mediaMs: Math.round(v.currentTime * 1000),
      rate: v.playbackRate || 1,
      playing: !v.paused && !v.ended && v.readyState > 2,
    }
  }

  private sendAnchor(): void {
    void send({ type: 'live.anchor', jobId: this.jobId, anchor: this.anchorNow() })
  }

  private onPlayback = () => this.sendAnchor()

  /**
   * Tap the element's own audio. Returns false when the browser won't give it
   * (cross-origin media without CORS throws); silence is detected later.
   */
  captureElement(): boolean {
    const v = this.video as HTMLVideoElement & {
      captureStream?: () => MediaStream
      mozCaptureStream?: () => MediaStream
    }
    let stream: MediaStream
    try {
      stream = (v.captureStream ?? v.mozCaptureStream)!.call(v)
    } catch {
      return false
    }
    // No audio track yet (playback not started) just reads as silence and
    // falls back to tabCapture after the silence window.
    this.capture = startPcmCapture(stream, {
      monitor: false, // the page keeps playing its own audio
      onChunk: (pcm, wallMs) => this.onChunk(pcm, wallMs),
    })
    return true
  }

  private onChunk(pcm: Int16Array, wallMs: number): void {
    const playing = !this.video.paused && !this.video.ended
    // captureStream still carries sound when the element is muted, but tell
    // the user anyway: a muted tab would be silent on the tabCapture path.
    this.setHint(
      playing && (this.video.muted || this.video.volume === 0)
        ? 'The video is muted — unmute it so it can be captioned.'
        : null,
    )
    if (playing && !this.video.muted && this.video.volume > 0 && levelDb(pcm) < SILENCE_DB) {
      this.silentMs += (pcm.length / 16000) * 1000
      if (this.silentMs >= SILENT_FALLBACK_MS && !this.fellBack) {
        this.fellBack = true
        this.stopCapture()
        void send({
          type: 'live.fallback',
          jobId: this.jobId,
          reason: 'element audio is silent (protected or cross-origin)',
        })
        return
      }
    } else if (levelDb(pcm) >= SILENCE_DB) this.silentMs = 0
    void send({ type: 'live.audio', jobId: this.jobId, wallMs, pcm: pcmToBase64(pcm) })
  }

  /** Smoothed display delay for drafts, ms. */
  private lagMs = 0

  /**
   * Engine cues are in media time (anchored), but drafts arrive a few seconds
   * after their words were spoken, when the playhead has already moved on:
   * shown at their true time they'd never be seen. While live, drafts are
   * shown delayed by the measured lag (Spec 08 §5: "a few seconds behind the
   * audio"); the final track goes back to exact timing.
   */
  showTrack(track: SubtitleTrack, final: boolean): void {
    if (final) {
      this.overlay.setCues(track.cues, false, 0)
      return
    }
    const last = track.cues[track.cues.length - 1]
    if (last) {
      const lag = this.video.currentTime * 1000 - last.endMs
      const clamped = Math.max(0, Math.min(MAX_LAG_MS, lag + LAG_MARGIN_MS))
      this.lagMs = this.lagMs === 0 ? clamped : Math.round(this.lagMs * 0.7 + clamped * 0.3)
    }
    this.overlay.setCues(track.cues, true, this.lagMs)
  }

  stopCapture(): void {
    this.capture?.stop()
    this.capture = null
  }

  /** Stop capturing but keep showing the captions (refinement result replaces them). */
  end(): void {
    this.stopCapture()
    for (const e of this.events) this.video.removeEventListener(e, this.onPlayback)
    this.video.removeEventListener('emptied', this.onEmptied)
  }

  destroy(): void {
    this.end()
    this.overlay.destroy()
  }
}
