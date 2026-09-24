import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'

/**
 * Service worker (Spec 09 §3): wake-on-event, stateless, engine calls live here.
 * M00: presence + ping only; job state arrives with the engine bridge (M02/M05).
 */
export default defineBackground(() => {
  console.info('[sublight] service worker ready')

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'ping') {
      sendResponse({ ok: true, version: 'm00' })
      return true
    }
    return undefined
  })
})
