/** Protocol constants (Spec 03 §1). */
export const PROTOCOL_VERSION = 1 as const
export const ENGINE_DEFAULT_PORT = 17421
export const ENGINE_BASE_URL = `http://127.0.0.1:${ENGINE_DEFAULT_PORT}` as const
export const WS_BASE_URL = `ws://127.0.0.1:${ENGINE_DEFAULT_PORT}` as const

/** Headers (Spec 03 §2 jobs, §4 WS). */
export const AUTH_HEADER = 'authorization'
export const BEARER_PREFIX = 'Bearer '
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/**
 * ID of the unpacked dev build: derived from the public `key` pinned in
 * apps/extension/wxt.config.ts, so every checkout loads with the same ID and
 * the engine can allowlist `chrome-extension://<id>` (Protocol §3.4).
 */
export const DEV_EXTENSION_ID = 'ehgdbfcecgkljnpmednociabmmjemfkf'

export const GpuJobConcurrency = {
  /** 1 ASR + 1 translation share ONE GPU slot (Spec 03 §7). */
  SHARED_GPU_SLOT: 1,
} as const
