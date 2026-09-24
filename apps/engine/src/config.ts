import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_DEFAULT_PORT } from '@sublight/protocol'

/**
 * Engine config (Spec 06 §1, Spec 02 §5): `~/.sublight/config.json`
 * — `SUBLIGHT_HOME` overrides the directory (tests use a temp dir).
 */
export interface EngineConfig {
  /** 32 random bytes, hex (Protocol §3). */
  token: string
  port: number
  defaults: {
    asrModel: string
    translateModel: string
  }
  autoRetry: boolean
  cacheLimits: {
    /** Upload/relay cache cap in bytes (default 20 GB, Protocol §7). */
    mediaBytes: number
  }
}

const DEFAULTS: Omit<EngineConfig, 'token'> = {
  port: ENGINE_DEFAULT_PORT,
  defaults: {
    asrModel: 'whisper-small',
    translateModel: 'qwen2.5-3b-instruct',
  },
  autoRetry: true,
  cacheLimits: { mediaBytes: 20 * 1024 ** 3 },
}

export function sublightHome(): string {
  return process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
}

/** Load config; generate + persist a fresh token when none exists yet. */
export function loadConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  const dir = sublightHome()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')

  let base: EngineConfig
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<EngineConfig>
      base = {
        ...DEFAULTS,
        ...raw,
        token:
          typeof raw.token === 'string' && raw.token ? raw.token : randomBytes(32).toString('hex'),
        defaults: { ...DEFAULTS.defaults, ...(raw.defaults ?? {}) },
        cacheLimits: { ...DEFAULTS.cacheLimits, ...(raw.cacheLimits ?? {}) },
      }
    } catch {
      base = { ...DEFAULTS, token: randomBytes(32).toString('hex') }
    }
  } else {
    base = { ...DEFAULTS, token: randomBytes(32).toString('hex') }
    writeFileSync(file, JSON.stringify(base, null, 2) + '\n', 'utf8')
  }

  const envPort = process.env.SUBLIGHT_PORT
  const merged: EngineConfig = {
    ...base,
    ...overrides,
    defaults: { ...base.defaults, ...(overrides?.defaults ?? {}) },
    cacheLimits: { ...base.cacheLimits, ...(overrides?.cacheLimits ?? {}) },
  }
  if (envPort) merged.port = Number(envPort)
  return merged
}
