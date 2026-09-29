import type { WsClientMessage, WsControlMessage, WsEvent } from './events'

/**
 * The engine's WebSocket (Protocol §4), shared by the Player and the
 * extension (code quality Q-3: Q3, Q4, Q7). It authenticates with the first
 * message, subscribes to jobs, and reconnects with capped backoff when the
 * connection drops (an engine restart, sleep, the engine idling out). Events
 * missed while disconnected are the caller's to recover over REST: it gets
 * `onReconnect` once a new connection is authenticated.
 *
 * Listener errors, synchronous or not, go to `onError` instead of vanishing.
 */
export interface EngineSocketOptions {
  /** ws://… of the engine's `/ws`. */
  url: () => string
  token: () => string | null | Promise<string | null>
  onReconnect?: () => void
  onError?: (err: unknown) => void
  /** Upper bound of the reconnect delay, ms. */
  maxDelayMs?: number
}

type Listener = (event: WsEvent) => void | Promise<void>

export class EngineSocket {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private jobIds = new Set<string>()
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private everConnected = false

  constructor(private readonly opts: EngineSocketOptions) {}

  async connect(): Promise<void> {
    this.closed = false
    if (this.ws) return
    const token = await this.opts.token()
    if (!token || this.closed || this.ws) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url())
    } catch {
      return this.scheduleReconnect()
    }
    this.ws = ws
    ws.onopen = () => this.send({ type: 'auth', token })
    ws.onmessage = (msg) => {
      let data: WsEvent | WsControlMessage
      try {
        data = JSON.parse(String(msg.data)) as WsEvent | WsControlMessage
      } catch {
        return // not ours to act on
      }
      if (data.type === 'auth.ok') {
        this.retry = 0
        if (this.jobIds.size) this.send({ type: 'subscribe', jobIds: [...this.jobIds] })
        if (this.everConnected) this.opts.onReconnect?.()
        this.everConnected = true
        return
      }
      if (data.type === 'error') return
      this.dispatch(data)
    }
    ws.onclose = () => {
      this.ws = null
      if (!this.closed) this.scheduleReconnect()
    }
    // A failed connection closes too; onclose reconnects.
    ws.onerror = () => {}
  }

  private scheduleReconnect(): void {
    clearTimeout(this.timer)
    const delay = Math.min(this.opts.maxDelayMs ?? 10_000, 500 * 2 ** this.retry++)
    this.timer = setTimeout(() => void this.connect(), delay)
  }

  private send(msg: WsClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /** Deliver an event to listeners (the socket's own messages, or tests). */
  dispatch(event: WsEvent): void {
    for (const l of this.listeners) {
      try {
        const r = l(event)
        if (r && typeof r.catch === 'function') r.catch((err: unknown) => this.opts.onError?.(err))
      } catch (err) {
        this.opts.onError?.(err)
      }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribe(jobId: string): void {
    this.jobIds.add(jobId)
    this.send({ type: 'subscribe', jobIds: [jobId] })
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }
}
