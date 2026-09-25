import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { probeEngine } from '../src/engine'
import { liveStatus, onLiveMessage, startLive, stopLive } from '../src/liveController'
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
    case 'live.start': {
      const frames = await readFrames(message.tabId)
      // The frame that owns the primary video (a playing one if any).
      const entries = Object.entries(frames).filter(([, f]) => f.primary)
      const owner = entries.find(([, f]) => f.primary!.isPlaying) ?? entries[0]
      if (!owner)
        return {
          tabId: message.tabId,
          jobId: '',
          source: null,
          phase: 'error',
          error: 'No video on this page.',
          cues: 0,
        }
      return startLive(message.tabId, Number(owner[0]))
    }
    case 'live.stop':
      return stopLive(message.tabId)
    case 'live.status':
      return liveStatus(message.tabId)
    case 'live.audio':
    case 'live.anchor':
    case 'live.fallback':
    case 'live.hint':
    case 'live.navigated':
      return onLiveMessage(message, sender)
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

  // Alt+Shift+L: toggle live captions on the active tab (Spec 09 §7).
  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'toggle-live' || tab?.id === undefined) return
    const tabId = tab.id
    void liveStatus(tabId).then((state) => {
      const active = state?.phase === 'starting' || state?.phase === 'listening'
      return handle({ type: active ? 'live.stop' : 'live.start', tabId }, {})
    })
  })

  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.storage.session.remove(tabKey(tabId))
  })
  // A full navigation drops every frame's state; content scripts re-report on load.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) void browser.storage.session.remove(tabKey(tabId))
  })
})
