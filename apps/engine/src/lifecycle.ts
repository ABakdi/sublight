import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthResponse } from '@sublight/protocol'
import { loadConfig } from './config'
import { enginePaths } from './paths'
import { enginePidFile } from './server'

/**
 * Starting, stopping and probing the engine from outside it: the
 * `sublight-engine` command and the native host the extension talks to
 * (M06b.3). Nothing here prints: the native host's stdout is its protocol.
 */

/** The running engine's health, or null if nothing answers. */
export async function health(): Promise<HealthResponse | null> {
  const { port, token } = loadConfig()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    })
    return res.ok ? ((await res.json()) as HealthResponse) : null
  } catch {
    return null
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readPid(): number | null {
  const file = enginePidFile(enginePaths().run)
  if (!existsSync(file)) return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid
  rmSync(file, { force: true }) // left behind by a crash
  return null
}

export type StartResult =
  { ok: true; already: boolean; pid?: number } | { ok: false; error: string; log: string }

/** Start the engine in the background (same program, same runtime flags), waiting until it answers. */
export async function startDetached(): Promise<StartResult> {
  if (await health()) return { ok: true, already: true }
  const logs = enginePaths().logs
  mkdirSync(logs, { recursive: true })
  const log = join(logs, 'engine.out')
  const out = openSync(log, 'a')
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'start'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    if (await health())
      return { ok: true, already: false, ...(child.pid ? { pid: child.pid } : {}) }
    if (child.exitCode !== null) break
  }
  return { ok: false, error: "the engine didn't start", log }
}

export type StopResult = { ok: true; wasRunning: boolean } | { ok: false; error: string }

/** Stop the engine this machine started (its pid file), letting jobs wind down. */
export async function stopEngine(): Promise<StopResult> {
  const pid = readPid()
  if (!pid) {
    if (!(await health())) return { ok: true, wasRunning: false }
    return { ok: false, error: 'the engine runs without a pid file here: stop it where it runs' }
  }
  process.kill(pid, 'SIGTERM')
  // The engine gives jobs up to 8 s to wind down.
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(200)
  if (alive(pid)) return { ok: false, error: `the engine (pid ${pid}) didn't stop` }
  return { ok: true, wasRunning: true }
}
