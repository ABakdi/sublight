import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const E2E_PLAYER_PORT = 5173
export const E2E_PLAYER_URL = `http://127.0.0.1:${E2E_PLAYER_PORT}`
export const E2E_ENGINE_PORT = 17421
export const E2E_ENGINE_URL = `http://127.0.0.1:${E2E_ENGINE_PORT}`
export const E2E_TOKEN = 'e2e'.padEnd(64, 'c')

export const E2E_ENGINE_HEALTH_URL = `${E2E_ENGINE_URL}/v1/health`
export const E2E_EXT_PROJECT_ROOT = `${resolve(process.cwd(), '..', 'apps', 'extension')}`

export const BRAVE_CANDIDATE_PATHS = [
  process.env.BRAVE_PATH,
  process.env.PLAYWRIGHT_BRAVE_PATH,
  '/usr/bin/brave',
  '/usr/bin/brave-browser',
  '/opt/brave.com/brave/brave-browser',
  '/snap/bin/brave',
].filter((p): p is string => Boolean(p))

export function findBravePath(): string | null {
  return BRAVE_CANDIDATE_PATHS.find((p) => existsSync(p)) ?? null
}
