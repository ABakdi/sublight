import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SubtitleCue } from '@sublight/core'
import { SubtitleOverlay } from '@sublight/overlay'

const DEMO_STEP_MS = 2500
const DEMO_CUE_MS = 2000
/** Cover at least this much past the playhead when the duration is unknown (live). */
const DEMO_HORIZON_MS = 60 * 60 * 1000

/** m:ss.t — tenths, since cues start on half seconds. */
function clock(ms: number): string {
  const tenths = Math.floor(ms / 100)
  const s = Math.floor(tenths / 10)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${tenths % 10}`
}

/**
 * Test captions: one cue every 2.5 s stamped with its own start time, so a
 * glance at the video clock shows whether the overlay is in sync. Stands in
 * for real tracks until the engine produces them (M03/M05).
 */
export function demoCues(video: HTMLVideoElement): SubtitleCue[] {
  const durationMs = Number.isFinite(video.duration)
    ? video.duration * 1000
    : video.currentTime * 1000 + DEMO_HORIZON_MS
  const cues: SubtitleCue[] = []
  for (let t = 0; t < durationMs; t += DEMO_STEP_MS) {
    cues.push({
      id: `demo-${t}`,
      startMs: t,
      endMs: t + DEMO_CUE_MS,
      text: `sublight test caption\ncue starts at ${clock(t)}`,
    })
  }
  return cues
}

/**
 * Overlay over a page video (Spec 05 §1, extension case). The page's own
 * layout is never touched: a fixed-position frame on <html> tracks the
 * video's box every animation frame, and the shared Shadow-DOM overlay
 * renders inside it. In fullscreen the frame moves into the fullscreen
 * element so it stays visible.
 */
export class DemoOverlay {
  private frame: HTMLDivElement
  private root: Root
  private raf = 0

  constructor(private readonly video: HTMLVideoElement) {
    this.frame = document.createElement('div')
    this.frame.dataset.sublightFrame = ''
    Object.assign(this.frame.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
      border: '0',
    })
    document.documentElement.append(this.frame)
    this.root = createRoot(this.frame)
    this.root.render(createElement(SubtitleOverlay, { cues: demoCues(video), video }))
    this.track()
  }

  get target(): HTMLVideoElement {
    return this.video
  }

  private track = () => {
    this.raf = requestAnimationFrame(this.track)
    const parent =
      document.fullscreenElement && document.fullscreenElement !== this.video
        ? document.fullscreenElement
        : document.documentElement
    if (this.frame.parentElement !== parent) parent.append(this.frame)
    const r = this.video.getBoundingClientRect()
    const s = this.frame.style
    const next = [`${r.left}px`, `${r.top}px`, `${r.width}px`, `${r.height}px`]
    if (s.left !== next[0]) s.left = next[0]!
    if (s.top !== next[1]) s.top = next[1]!
    if (s.width !== next[2]) s.width = next[2]!
    if (s.height !== next[3]) s.height = next[3]!
    s.display = r.width > 0 && r.height > 0 && this.video.isConnected ? 'block' : 'none'
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.root.unmount()
    this.frame.remove()
  }
}
