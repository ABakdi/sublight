/**
 * The native messaging host (M06b.3): the browser starts `sublight-engine
 * native-host`, registered by install.sh, when the extension asks. It only
 * manages the engine's lifecycle and hands the extension its token; all data
 * still goes over HTTP/WS. One request per message, answered with the same `id`.
 */
export const NATIVE_HOST_NAME = 'sublight.engine'

export type NativeCommand = 'status' | 'start' | 'stop' | 'token' | 'version'

export interface NativeRequest {
  id?: string
  command: NativeCommand
}

/** What the engine is doing, as the popup shows it. */
export interface NativeStatus {
  running: boolean
  /** Engine version of the running engine, or of the installed one when stopped. */
  version: string
  port: number
  activeJobs?: number
  queuedJobs?: number
  uptimeMs?: number
}

export type NativeResponse =
  | ({ id?: string; ok: true; command: 'status' } & NativeStatus)
  | { id?: string; ok: true; command: 'start'; started: boolean; port: number }
  | { id?: string; ok: true; command: 'stop'; stopped: boolean }
  | { id?: string; ok: true; command: 'token'; token: string; port: number }
  | { id?: string; ok: true; command: 'version'; version: string; protocol: number }
  | { id?: string; ok: false; error: string }
