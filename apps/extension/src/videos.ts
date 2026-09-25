import type { VideoState } from './messages'

/** Visible area of a video in the viewport, px². 0 when hidden or off-screen. */
export function visibleArea(video: HTMLVideoElement): number {
  const r = video.getBoundingClientRect()
  const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)
  const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)
  return w > 0 && h > 0 ? w * h : 0
}

export function isPlaying(video: HTMLVideoElement): boolean {
  return !video.paused && !video.ended && video.readyState > 2
}

/**
 * The video the overlay belongs to (Spec 09 §4): a playing, visible video
 * beats a paused one; among equals, the larger visible area wins.
 */
export function pickPrimary(videos: HTMLVideoElement[]): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null
  let bestScore = 0
  for (const v of videos) {
    const area = visibleArea(v)
    if (area === 0) continue
    const score = area * (isPlaying(v) ? 4 : 1)
    if (score > bestScore) {
      best = v
      bestScore = score
    }
  }
  return best
}

export function snapshot(
  videos: HTMLVideoElement[],
  primary: HTMLVideoElement | null,
  demoCaptions: boolean,
): VideoState {
  return {
    frame: window.self === window.top ? 'top' : 'iframe',
    url: location.href,
    videoCount: videos.length,
    primary: primary
      ? {
          isPlaying: isPlaying(primary),
          currentTimeMs: Math.round(primary.currentTime * 1000),
          durationMs: Number.isFinite(primary.duration)
            ? Math.round(primary.duration * 1000)
            : null,
          playbackRate: primary.playbackRate,
          width: Math.round(primary.getBoundingClientRect().width),
          height: Math.round(primary.getBoundingClientRect().height),
        }
      : null,
    demoCaptions,
    reportedAt: Date.now(),
  }
}
