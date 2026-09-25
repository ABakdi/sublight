import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  ffmpeg: { ffmpeg: string; ffprobe: string }
}

const DEFAULTS: Omit<EngineConfig, 'token'> = {
  port: ENGINE_DEFAULT_PORT,
  defaults: {
    asrModel: 'whisper-small',
    translateModel: 'qwen2.5-3b-instruct',
  },
  autoRetry: true,
  allowedOrigins: [],
  cacheLimits: { mediaBytes: 20 * 1024 ** 3, uploadBytes: 20 * 1024 ** 3 },
  whisper: { port: 17422, gpu: 'auto', threads: 4 },
  ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
}

export function sublightHome(): string {
  return process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
}

/** Load config; generate + persist a fresh token when none exists yet. */
export function loadConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  const dir = sublightHome()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')

  let raw: Partial<EngineConfig> | null = null
  if (existsSync(file)) {
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
    ffmpeg: { ...DEFAULTS.ffmpeg, ...(raw?.ffmpeg ?? {}) },
  }
  // A freshly generated token must survive restarts, or every paired client breaks.
  if (!hasToken) writeFileSync(file, JSON.stringify(base, null, 2) + '\n', 'utf8')

  const envPort = process.env.SUBLIGHT_PORT
  const merged: EngineConfig = {
    ...base,
    ...overrides,
    defaults: { ...base.defaults, ...(overrides?.defaults ?? {}) },
    cacheLimits: { ...base.cacheLimits, ...(overrides?.cacheLimits ?? {}) },
    whisper: { ...base.whisper, ...(overrides?.whisper ?? {}) },
    ffmpeg: { ...base.ffmpeg, ...(overrides?.ffmpeg ?? {}) },
  }
  const port = Number(envPort)
  if (envPort && Number.isInteger(port) && port > 0 && port < 65536) merged.port = port
  return merged
}
