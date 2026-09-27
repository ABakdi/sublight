import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_DEFAULT_PORT, PLAYER_DEFAULT_PORT } from '@sublight/protocol'

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
  /** Extra CORS origins, e.g. `chrome-extension://<store id>` (Protocol §3.4). */
  allowedOrigins: string[]
  cacheLimits: {
    /** Normalized-audio cache budget in bytes; LRU-evicted past it. */
    mediaBytes: number
    /** Largest accepted upload in bytes (default 20 GB, Protocol §7). */
    uploadBytes: number
  }
  whisper: {
    /** whisper-server binary; default from `pnpm engine:setup-whisper` (~/.sublight/bin). */
    binary?: string
    port: number
    /** 'auto' uses the GPU when the binary was built with CUDA; 'off' forces CPU. */
    gpu: 'auto' | 'off'
    threads: number
  }
  llama: {
    /** llama-server binary; default from `pnpm engine:setup-llama` (~/.sublight/bin). */
    binary?: string
    port: number
    gpu: 'auto' | 'off'
    threads: number
    contextTokens: number
  }
  ffmpeg: { ffmpeg: string; ffprobe: string }
  /**
   * Trust the Vite dev Player (`:5173`). Off unless developing (`SUBLIGHT_DEV=1`,
   * `pnpm dev:engine`): any Vite app on that port could otherwise pair.
   */
  devOrigins: boolean
  /**
   * Let page and media URLs point at this computer or the local network (a
   * home media server). Off: web pages choose those URLs (baseline A10).
   */
  allowPrivateNetworks: boolean
  /** The built Player, served on its own origin (`0` turns it off; Spec 06 §1). */
  player: {
    port: number
    /** The Player's build; default: `player/` next to the engine, or the repo's `apps/player/dist`. */
    dir?: string
  }
}

const DEFAULTS: Omit<EngineConfig, 'token'> = {
  port: ENGINE_DEFAULT_PORT,
  defaults: {
    asrModel: 'whisper-small',
    translateModel: 'qwen3-4b-instruct',
  },
  autoRetry: true,
  allowedOrigins: [],
  cacheLimits: { mediaBytes: 20 * 1024 ** 3, uploadBytes: 20 * 1024 ** 3 },
  whisper: { port: 17422, gpu: 'auto', threads: 4 },
  llama: { port: 17423, gpu: 'auto', threads: 4, contextTokens: 4096 },
  ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  player: { port: PLAYER_DEFAULT_PORT },
  devOrigins: false,
  allowPrivateNetworks: false,
}

export function sublightHome(): string {
  return process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
}

/** Load config; generate + persist a fresh token when none exists yet. */
export function loadConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  const dir = sublightHome()
  // Private: it holds the token, jobs (the pages you watched) and logs (baseline G1).
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700)
  } catch {
    // a filesystem without Unix modes
  }
  const file = join(dir, 'config.json')

  let raw: Partial<EngineConfig> | null = null
  if (existsSync(file)) {
    // It holds the token: only the user may read it (older installs wrote 0644).
    try {
      if (statSync(file).mode & 0o077) chmodSync(file, 0o600)
    } catch {
      // a filesystem without Unix modes
    }
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<EngineConfig>
    } catch {
      // Unreadable config: keep it aside rather than overwrite what the user wrote.
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    }
  }

  const hasToken = typeof raw?.token === 'string' && raw.token !== ''
  const base: EngineConfig = {
    ...DEFAULTS,
    ...raw,
    token: hasToken ? raw!.token! : randomBytes(32).toString('hex'),
    defaults: { ...DEFAULTS.defaults, ...(raw?.defaults ?? {}) },
    cacheLimits: { ...DEFAULTS.cacheLimits, ...(raw?.cacheLimits ?? {}) },
    whisper: { ...DEFAULTS.whisper, ...(raw?.whisper ?? {}) },
    llama: { ...DEFAULTS.llama, ...(raw?.llama ?? {}) },
    ffmpeg: { ...DEFAULTS.ffmpeg, ...(raw?.ffmpeg ?? {}) },
    player: { ...DEFAULTS.player, ...(raw?.player ?? {}) },
  }
  // A freshly generated token must survive restarts, or every paired client breaks.
  if (!hasToken)
    writeFileSync(file, JSON.stringify(base, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })

  const envPort = process.env.SUBLIGHT_PORT
  const merged: EngineConfig = {
    ...base,
    ...overrides,
    defaults: { ...base.defaults, ...(overrides?.defaults ?? {}) },
    cacheLimits: { ...base.cacheLimits, ...(overrides?.cacheLimits ?? {}) },
    whisper: { ...base.whisper, ...(overrides?.whisper ?? {}) },
    llama: { ...base.llama, ...(overrides?.llama ?? {}) },
    ffmpeg: { ...base.ffmpeg, ...(overrides?.ffmpeg ?? {}) },
    player: { ...base.player, ...(overrides?.player ?? {}) },
  }
  const port = Number(envPort)
  if (envPort && Number.isInteger(port) && port > 0 && port < 65536) merged.port = port
  if (process.env.SUBLIGHT_DEV === '1') merged.devOrigins = true
  const envPlayerPort = process.env.SUBLIGHT_PLAYER_PORT
  const playerPort = Number(envPlayerPort)
  if (envPlayerPort && Number.isInteger(playerPort) && playerPort >= 0 && playerPort < 65536)
    merged.player = { ...merged.player, port: playerPort }
  return merged
}

/**
 * A new token, saved to config.json (M06.3, "unpair everything"): every
 * client must pair again. Only the token field changes in the file, so env
 * overrides never get written into it.
 */
export function rotateToken(config: EngineConfig): string {
  const file = join(sublightHome(), 'config.json')
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // missing or unreadable: write what the engine runs with
    raw = { ...config }
  }
  const token = randomBytes(32).toString('hex')
  raw.token = token
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  config.token = token
  return token
}
