import { browser } from 'wxt/browser'
import type { EngineStatus, Message, TabStatus } from './messages'

/** Typed request/response to the service worker. */
export function send(message: { type: 'engine.status' }): Promise<EngineStatus>
export function send(message: { type: 'tab.status'; tabId: number }): Promise<TabStatus>
export function send(message: Message): Promise<unknown>
export function send(message: Message): Promise<unknown> {
  return browser.runtime.sendMessage(message)
}
