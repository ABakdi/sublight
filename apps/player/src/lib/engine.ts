import type {
  ErrorEnvelope,
  HealthResponse,
  JobCreation,
  JobResult,
  JobSummary,
  ModelInfo,
  ModelsResponse,
  UploadResult,
  WsClientMessage,
  WsControlMessage,
  WsEvent,
} from '@sublight/protocol'

const ENGINE_URL_KEY = 'sublight.engineUrl'
const TOKEN_KEY = 'sublight.token'
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:17421'

/** localStorage can throw (private windows, blocked storage); treat that as "unset". */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function engineBaseUrl(): string {
  return readStorage(ENGINE_URL_KEY) ?? DEFAULT_ENGINE_URL
}

export function engineToken(): string | null {
  const token = readStorage(TOKEN_KEY)
  return token && token.trim() ? token.trim() : null
}

/** Paired token (Spec 04 §8: same model as the extension; `sublight://pair` arrives in M06). */
export function setEngineToken(token: string | null): void {
  try {
    if (token && token.trim()) localStorage.setItem(TOKEN_KEY, token.trim())
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage blocked: the token lives for this session only via the caller's state
  }
}

/** A protocol error (Protocol §6), or OFFLINE when the engine can't be reached. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

async function toError(res: Response): Promise<EngineError> {
  const body = (await res.json().catch(() => null)) as ErrorEnvelope | null
  return new EngineError(
    body?.error.code ?? `HTTP_${res.status}`,
    body?.error.message ?? `engine answered HTTP ${res.status}`,
    res.status,
    body?.error.retryable ?? false,
  )
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const token = engineToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let res: Response
  try {
    res = await fetch(`${engineBaseUrl()}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (init.signal?.aborted) throw err
    throw new EngineError('OFFLINE', 'The engine is not reachable on this computer.')
  }
  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

export interface UploadOptions {
  onProgress?: (sentBytes: number, totalBytes: number) => void
  signal?: AbortSignal
}

/**
 * The engine API as the player uses it (Protocol §2). Grouped in one object so
 * tests can stub single calls with `vi.spyOn(engine, 'createJob')`.
 */
export const engine = {
  health: () => request<HealthResponse>('/v1/health', {}, 1500),
  models: () => request<ModelsResponse>('/v1/models'),
  installModel: (id: string) =>
    request<{ ok: boolean; model: ModelInfo }>(`/v1/models/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    }),

  /** Media metadata by id or `sha256:` hash; null when the engine no longer has it. */
  async mediaInfo(ref: string): Promise<{ mediaHash: string; durationMs: number } | null> {
    try {
      return await request(`/v1/media/${encodeURIComponent(ref)}`)
    } catch (err) {
      if (err instanceof EngineError && err.status === 404) return null
      throw err
    }
  },

  /**
   * Stream a local file to `PUT /v1/media/:id` (ADR-0011: the engine extracts
   * the audio). XHR rather than fetch: it reports upload progress and streams
   * the File from disk without buffering it in memory.
   */
  uploadMedia(file: File, mediaId: string, opts: UploadOptions = {}): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${engineBaseUrl()}/v1/media/${encodeURIComponent(mediaId)}`)
      const token = engineToken()
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      // Header values must be ISO-8859-1; percent-encode anything else.
      xhr.setRequestHeader('X-Source-Name', encodeURIComponent(file.name))
      xhr.upload.onprogress = (e) =>
        opts.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size)
      xhr.onload = () => {
        let body: unknown = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          // non-JSON answer
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult)
        else {
          const env = body as ErrorEnvelope | null
          reject(
            new EngineError(
              env?.error.code ?? `HTTP_${xhr.status}`,
              env?.error.message ?? `upload failed (HTTP ${xhr.status})`,
              xhr.status,
            ),
          )
        }
      }
      xhr.onerror = () =>
        reject(new EngineError('OFFLINE', 'The engine is not reachable on this computer.'))
      xhr.onabort = () => reject(new DOMException('upload cancelled', 'AbortError'))
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(file)
    })
  },

  createJob: (body: JobCreation, idempotencyKey: string) =>
    request<JobSummary>('/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
  job: (id: string) => request<JobSummary>(`/v1/jobs/${encodeURIComponent(id)}`),
  result: (id: string) => request<JobResult>(`/v1/jobs/${encodeURIComponent(id)}/result`),
  cancelJob: (id: string) =>
    request<JobSummary>(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
}

export interface HealthResult {
  state: 'online' | 'offline' | 'unauthorized'
  health?: HealthResponse
  error?: string
}

/** Bail out quickly when the engine isn't running (Spec 04 §8). */
export async function fetchEngineHealth(): Promise<HealthResult> {
  try {
    return { state: 'online', health: await engine.health() }
  } catch (err) {
    if (err instanceof EngineError && err.status === 401) {
      return { state: 'unauthorized', error: err.message }
    }
    return { state: 'offline', error: err instanceof Error ? err.message : String(err) }
  }
}

type Listener = (event: WsEvent) => void

/**
 * WS event stream (Protocol §4): authenticates with the first message,
 * resubscribes and reconnects with backoff. REST stays the source of truth;
 * callers also poll, so a dropped socket only makes updates slower.
 */
export class EngineSocket {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private jobIds = new Set<string>()
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  connect(): void {
    this.closed = false
    const token = engineToken()
    if (!token || this.ws) return
    const url = `${engineBaseUrl().replace(/^http/, 'ws')}/ws`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return this.scheduleReconnect()
    }
    this.ws = ws
    ws.onopen = () => this.send({ type: 'auth', token })
    ws.onmessage = (msg) => {
      const data = JSON.parse(String(msg.data)) as WsEvent | WsControlMessage
      if (data.type === 'auth.ok') {
        this.retry = 0
        if (this.jobIds.size) this.send({ type: 'subscribe', jobIds: [...this.jobIds] })
        return
      }
      if (data.type === 'error') return
      this.dispatch(data)
    }
    ws.onclose = () => {
      this.ws = null
      if (!this.closed) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.timer)
    const delay = Math.min(10_000, 500 * 2 ** this.retry++)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /** Deliver an event to listeners (the socket's own messages, or tests). */
  dispatch(event: WsEvent): void {
    for (const l of this.listeners) l(event)
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribe(jobId: string): void {
    this.jobIds.add(jobId)
    this.send({ type: 'subscribe', jobIds: [jobId] })
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }
}
