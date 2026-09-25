import { browser } from 'wxt/browser'
import type { EngineStatus, LiveState, Message, TabStatus } from './messages'

/** Typed request/response to the service worker. */
export function send(message: { type: 'engine.status' }): Promise<EngineStatus>
export function send(message: { type: 'tab.status'; tabId: number }): Promise<TabStatus>
export function send(message: {
  type: 'live.start' | 'live.stop' | 'live.status'
  tabId: number
}): Promise<LiveState | null>
export function send(message: Message): Promise<unknown>
export function send(message: Message): Promise<unknown> {
  return browser.runtime.sendMessage(message)
}
