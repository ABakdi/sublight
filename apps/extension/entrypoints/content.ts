import { defineContentScript } from 'wxt/utils/define-content-script'

/**
 * All-frames content script (Spec 09 §2, §4): videos can live in iframes, so we
 * inject everywhere at document_idle. M00: presence probe — full video
 * discovery, the overlay host, and tab-capture bridge land in M05.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    const videoCount = document.querySelectorAll('video').length
    console.info(
      '[sublight] content script loaded',
      JSON.stringify({
        host: location.hostname,
        videoCount,
        frame: window.self !== window.top ? 'iframe' : 'top',
      }),
    )
  },
})
