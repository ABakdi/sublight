import { defineContentScript } from 'wxt/utils/define-content-script'
import { browser } from 'wxt/browser'
import { PageCaptions } from '../src/captionsContent'
import { DemoOverlay } from '../src/demoOverlay'
import { LiveSession } from '../src/liveContent'
import { isMessage, type Message } from '../src/messages'
import { isPlaying, pickPrimary, snapshot, videoKey, videoPageUrl } from '../src/videos'
import { DELAY_STEP_MS } from '../src/quickControls'

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
        for (const e of MEDIA_EVENTS)
          v.addEventListener(e, () => {
            schedule(true)
            // A feed's next video starts playing: caption it without waiting for the rescan.
            if (e === 'play') setTimeout(() => follow(), 300)
          })
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
    /** The page of the video being captioned (a feed item's own URL on TikTok/Reels). */
    let captionsPage = ''
    /**
     * Captions stay on for this page until the viewer stops them: when another
     * video takes over (scrolling a feed, the next video, SPA navigation), it
     * gets captioned too (Spec 09 §4.8).
     */
    let following = false
    let lastFollow: { video: HTMLVideoElement; page: string } | null = null

    const endCaptionsForNavigation = () => {
      if (!captions) return
      const jobId = captions.jobId
      captions.destroy()
      captions = null
      // The engine stops that job; `following` picks up the next video.
      void browser.runtime
        .sendMessage({ type: 'captions.navigated', jobId } satisfies Message)
        .catch(() => {})
    }

    /** Caption the video that is playing now, if it isn't the captioned one. */
    const follow = () => {
      if (!following) return
      const playing = videos.filter(isPlaying)
      const primary = pickPrimary(playing)
      if (!primary) return
      const page = videoKey(videoPageUrl(primary))
      if (captions && captions.target === primary && page === captionsPage) return
      if (lastFollow?.video === primary && lastFollow.page === page) return
      lastFollow = { video: primary, page }
      if (captions) endCaptionsForNavigation()
      const msg: Message = { type: 'captions.next', state: snapshot(videos, primary, demoOn) }
      void browser.runtime.sendMessage(msg).catch(() => {})
    }

    // Reload, a real navigation or closing: nobody will see these captions.
    // (In-page URL changes don't fire pagehide; `follow` handles those.)
    window.addEventListener('pagehide', () => {
      if (!captions && !live) return
      void browser.runtime.sendMessage({ type: 'page.gone' } satisfies Message).catch(() => {})
    })

    // Keyboard (Spec 09 §7): Alt+Shift+V captions on/off, Alt+Shift+, and . delay
    // −/+100 ms, Alt+Shift+0 no delay, Alt+Shift+T translate on/off,
    // Alt+Shift+K open/close the controls, Alt+Shift+B original + translation. Physical keys (e.code), so any layout works.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return
        const controls = captions?.controls ?? live?.controls
        if (!controls) return
        const origin = e.composedPath()[0] as HTMLElement | undefined
        if (
          origin &&
          (origin.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(origin.tagName))
        )
          return
        const actions: Record<string, () => void> = {
          KeyV: () => controls.toggleVisible(),
          Period: () => controls.nudge(DELAY_STEP_MS),
          Comma: () => controls.nudge(-DELAY_STEP_MS),
          Digit0: () => controls.setDelay(0),
          KeyT: () => void controls.toggleTarget(),
          KeyK: () => controls.toggleExpanded(),
          KeyB: () => controls.toggleBoth(),
        }
        const act = actions[e.code]
        if (!act) return
        e.preventDefault()
        e.stopImmediatePropagation()
        act()
      },
      true,
    )

    setInterval(() => {
      // A real move to another video, not YouTube dropping `&t=` from the URL.
      if (videoKey(location.href) !== videoKey(lastUrl)) {
        lastUrl = location.href
        endLiveForNavigation()
        endCaptionsForNavigation()
        lastFollow = null
        schedule(true)
      } else schedule()
      follow()
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
          captionsPage = videoKey(videoPageUrl(primary))
          following = true
          lastFollow = { video: primary, page: captionsPage }
          sendResponse({ ok: true })
          return undefined
        }
        case 'captions.track':
          captions?.showTrack(message.track, message.final, message.companion)
          sendResponse({ ok: true })
          return undefined
        case 'captions.end':
          captions?.destroy()
          captions = null
          following = false
          lastFollow = null
          sendResponse({ ok: true })
          return undefined
        case 'captions.ui':
          captions?.controls.setNote(message.note)
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
          following = false
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
