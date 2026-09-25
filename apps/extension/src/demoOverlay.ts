import type { SubtitleCue } from '@sublight/core'
import { OverlayFrame } from './overlayFrame'

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

/** Test captions over a page video: an OverlayFrame showing `demoCues`. */
export class DemoOverlay extends OverlayFrame {
  constructor(video: HTMLVideoElement) {
    super(video)
    this.setCues(demoCues(video), false)
  }
}
