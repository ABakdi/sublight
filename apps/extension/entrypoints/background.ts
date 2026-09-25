import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { probeEngine } from '../src/engine'
import { isMessage, type Message, type TabStatus, type VideoState } from '../src/messages'

type FrameMap = Record<string, VideoState>

const tabKey = (tabId: number) => `tab:${tabId}`

async function readFrames(tabId: number): Promise<FrameMap> {
  const got = await browser.storage.session.get(tabKey(tabId))
  return (got[tabKey(tabId)] as FrameMap | undefined) ?? {}
}

async function tabStatus(tabId: number): Promise<TabStatus> {
  const frames = Object.entries(await readFrames(tabId))
    .sort(([a], [b]) => Number(a) - Number(b)) // frameId 0 = top frame
    .map(([, state]) => state)
  return { tabId, frames }
}

async function handle(message: Message, sender: { tab?: { id?: number }; frameId?: number }) {
  switch (message.type) {
    case 'ping':
      return { ok: true, version: browser.runtime.getManifest().version }
    case 'video.state': {
      const tabId = sender.tab?.id
      if (tabId === undefined) return { ok: false }
      const frames = await readFrames(tabId)
      frames[String(sender.frameId ?? 0)] = message.state
      await browser.storage.session.set({ [tabKey(tabId)]: frames })
      return { ok: true }
    }
    case 'tab.status':
      return tabStatus(message.tabId)
    case 'engine.status':
      return probeEngine()
    case 'demo.toggle': {
      const set: Message = { type: 'demo.set', on: message.on }
      await browser.tabs.sendMessage(message.tabId, set)
      return { ok: true }
    }
    default:
      return undefined
  }
}

/**
 * Service worker (Spec 09 §3): wake-on-event and stateless — per-tab video
 * state lives in storage.session so it survives SW restarts. Engine calls
 * happen only here and in extension pages; content scripts never see the token.
 */
export default defineBackground(() => {
  console.info('[sublight] service worker ready')

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isMessage(message)) return undefined
    handle(message, sender).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    return true // async sendResponse
  })

  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.storage.session.remove(tabKey(tabId))
  })
  // A full navigation drops every frame's state; content scripts re-report on load.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) void browser.storage.session.remove(tabKey(tabId))
  })
})
