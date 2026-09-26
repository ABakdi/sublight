import type { VideoState } from './messages'

const FEED_LINKS: [RegExp, RegExp][] = [
  // host, path of one video's own page
  [/(^|\.)tiktok\.com$/, /\/@[^/]+\/video\/\d+/],
  [/(^|\.)instagram\.com$/, /\/(reels?|p)\/[\w-]+/],
  [/(^|\.)facebook\.com$/, /\/(reel|watch|videos)\/?[\w.-]*/],
]

/**
 * This video's own page. Feeds (TikTok's For You, Instagram's Reels tab) show
 * many videos under one URL; the engine needs the one playing. Walk up from
 * the <video> to the nearest link to a single video, stopping before a
 * container that holds other videos (the next feed item's link isn't ours).
 */
export function videoPageUrl(video: HTMLElement, href = location.href): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return href
  }
  const rule = FEED_LINKS.find(([host]) => host.test(url.hostname))
  if (!rule || rule[1].test(url.pathname)) return href
  let node = video.parentElement
  for (let depth = 0; node && depth < 15; depth++, node = node.parentElement) {
    if (node.querySelectorAll('video').length > 1) break
    const link = [...node.querySelectorAll('a[href]')].find((a) =>
      rule[1].test(new URL(a.getAttribute('href')!, href).pathname),
    )
    if (link) return new URL(link.getAttribute('href')!, href).toString()
  }
  return href
}

/** The same video whatever start-time or tracking parameters its URL gains or loses. */
export function videoKey(href: string): string {
  try {
    const u = new URL(href)
    u.hash = ''
    for (const p of ['t', 'start', 'time_continue', 'si', 'feature', 'pp', 'ab_channel'])
      u.searchParams.delete(p)
    return u.toString()
  } catch {
    return href
  }
}

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
    title: document.title,
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
          src: /^https?:/i.test(primary.currentSrc) ? primary.currentSrc : null,
          pageUrl: videoPageUrl(primary),
        }
      : null,
    demoCaptions,
    reportedAt: Date.now(),
  }
}
