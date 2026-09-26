import { defineContentScript } from 'wxt/utils/define-content-script'
import { browser } from 'wxt/browser'
import { PageCaptions } from '../src/captionsContent'
import { DemoOverlay } from '../src/demoOverlay'
import { LiveSession } from '../src/liveContent'
import { isMessage, type Message } from '../src/messages'
import { pickPrimary, snapshot, videoKey } from '../src/videos'

const MEDIA_EVENTS = ['play', 'pause', 'loadedmetadata', 'seeked', 'ratechange', 'ended', 'emptied']
const RESCAN_MS = 2000

/**
 * All-frames content script (Spec 09 §2, §4): videos can live in iframes, so
 * we inject everywhere at document_idle. Discovers <video> elements, reports
 * their state to the service worker on media events and DOM changes (not on a
 * timer, so a playing tab doesn't keep the SW awake), and mounts test
 * captions on request. Capture wiring lands in M05.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    const isTop = window.self === window.top
    const watched = new WeakSet<HTMLVideoElement>()
    let videos: HTMLVideoElement[] = []
    let demoOn = false
    let overlay: DemoOverlay | null = null
    let lastSent = ''
    let lastUrl = location.href
    let timer: ReturnType<typeof setTimeout> | undefined

    const syncOverlay = (primary: HTMLVideoElement | null) => {
      if (overlay && (!demoOn || overlay.target !== primary)) {
        overlay.destroy()
        overlay = null
      }
      // Another sublight overlay (e.g. the Sublight Player page) already owns this video.
      const foreign = document.querySelector('[data-sublight-host]:not([data-sublight-frame] *)')
      if (demoOn && primary && !overlay && !foreign) overlay = new DemoOverlay(primary)
    }

    const report = (force = false) => {
      videos = Array.from(document.querySelectorAll('video'))
      for (const v of videos) {
        if (watched.has(v)) continue
        watched.add(v)
        for (const e of MEDIA_EVENTS) v.addEventListener(e, () => schedule(true))
      }
      const primary = pickPrimary(videos) ?? videos[0] ?? null
      syncOverlay(primary)
      // Frames without video stay silent; the top frame always reports so the popup can say "no video".
      if (!isTop && videos.length === 0) return
      const state = snapshot(videos, primary, demoOn)
      const key = JSON.stringify({
        ...state,
        reportedAt: 0,
        primary: state.primary && { ...state.primary, currentTimeMs: 0 },
      })
      if (!force && key === lastSent) return
      lastSent = key
      const msg: Message = { type: 'video.state', state }
      browser.runtime.sendMessage(msg).catch(() => {
        // SW restarting or extension reloaded; the next event reports again.
      })
    }

    const schedule = (force = false) => {
      clearTimeout(timer)
      timer = setTimeout(() => report(force), 150)
    }

    new MutationObserver(() => schedule()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    // SPA navigations (YouTube etc.) swap videos without a page load.
    let live: LiveSession | null = null

    /** The page moved on (SPA navigation, new src): drop the session and its captions. */
    const endLiveForNavigation = () => {
      if (!live) return
      const jobId = live.jobId
      live.destroy()
      live = null
      void browser.runtime
        .sendMessage({ type: 'live.navigated', jobId } satisfies Message)
        .catch(() => {})
    }

    let captions: PageCaptions | null = null
    const endCaptionsForNavigation = () => {
      if (!captions) return
      const jobId = captions.jobId
      captions.destroy()
      captions = null
      void browser.runtime
        .sendMessage({ type: 'captions.navigated', jobId } satisfies Message)
        .catch(() => {})
    }

    setInterval(() => {
      // A real move to another video, not YouTube dropping `&t=` from the URL.
      if (videoKey(location.href) !== videoKey(lastUrl)) {
        lastUrl = location.href
        endLiveForNavigation()
        endCaptionsForNavigation()
        schedule(true)
      } else schedule()
    }, RESCAN_MS)

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!isMessage(message)) return undefined
      switch (message.type) {
        case 'demo.set':
          demoOn = message.on
          report(true)
          sendResponse({ ok: true, mounted: overlay !== null })
          return undefined
        case 'captions.begin': {
          const primary = pickPrimary(videos) ?? videos[0] ?? null
          if (!primary) {
            sendResponse({ ok: false, reason: 'no-video' })
            return undefined
          }
          if (document.querySelector('[data-sublight-host]:not([data-sublight-frame] *)')) {
            sendResponse({ ok: false, reason: 'player' })
            return undefined
          }
          captions?.destroy()
          live?.destroy()
          live = null
          demoOn = false
          syncOverlay(null)
          captions = new PageCaptions(primary, message.jobId)
          sendResponse({ ok: true })
          return undefined
        }
        case 'captions.track':
          captions?.showTrack(message.track, message.final)
          sendResponse({ ok: true })
          return undefined
        case 'captions.end':
          captions?.destroy()
          captions = null
          sendResponse({ ok: true })
          return undefined
        case 'live.begin': {
          // Only the frame that owns the primary video takes the session.
          const primary = pickPrimary(videos) ?? videos[0] ?? null
          if (!primary) {
            sendResponse({ ok: false, reason: 'no-video' })
            return undefined
          }
          // The Sublight Player captions its own video: never add a second overlay (Spec 01 §5).
          if (document.querySelector('[data-sublight-host]:not([data-sublight-frame] *)')) {
            sendResponse({ ok: false, reason: 'player' })
            return undefined
          }
          live?.destroy()
          captions?.destroy()
          captions = null
          demoOn = false
          syncOverlay(null) // live captions replace test captions
          live = new LiveSession(primary, message.jobId, endLiveForNavigation)
          const captured = message.captureElement ? live.captureElement() : false
          sendResponse({ ok: true, captured })
          return undefined
        }
        case 'live.track':
          live?.showTrack(message.track, message.final)
          sendResponse({ ok: true })
          return undefined
        case 'live.end':
          live?.end()
          sendResponse({ ok: true })
          return undefined
        case 'live.notice':
          if (message.message) console.info('[sublight]', message.message)
          sendResponse({ ok: true })
          return undefined
        default:
          return undefined
      }
    })

    console.info(
      '[sublight] content script loaded',
      JSON.stringify({
        host: location.hostname,
        videoCount: document.querySelectorAll('video').length,
        frame: isTop ? 'top' : 'iframe',
      }),
    )
    report(true)
  },
})
