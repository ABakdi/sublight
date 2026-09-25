import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  type WsClientMessage,
  type WsControlMessage,
  type WsEvent,
} from '@sublight/protocol'
import { allowedHosts } from './auth'
import type { EventBus } from './events'

export const WS_PATH = '/ws'
const AUTH_TIMEOUT_MS = 1000
const MAX_MSGS_PER_SEC = 20

export interface WsOptions {
  port: number
  token: string
  origins: Set<string>
  bus: EventBus
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

/**
 * Event stream at ws://127.0.0.1:17421/ws (Spec 03 §4). The upgrade passes the
 * same Host/Origin checks as HTTP; the first message must be `auth` with the
 * bearer token or the socket closes within 1 s. Clients see every event until
 * they `subscribe` to specific jobs; model/engine events always go out.
 */
export function attachWebSocket(server: Server, opts: WsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const hosts = allowedHosts(opts.port)

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== WS_PATH) return reject(socket, 404, 'Not Found')
    if (!hosts.has(req.headers.host ?? '')) return reject(socket, 403, 'Forbidden')
    const origin = req.headers.origin
    if (origin && !opts.origins.has(origin)) return reject(socket, 403, 'Forbidden')
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws))
  })

  function serve(ws: WebSocket): void {
    let authed = false
    let subscribed: Set<string> | null = null
    let windowStart = Date.now()
    let count = 0
    const send = (msg: WsEvent | WsControlMessage) =>
      ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg))
    const deny = (code: string, message: string) => {
      send({ type: 'error', code, message })
      ws.close(4401, code)
    }
    const timer = setTimeout(
      () => !authed && deny('UNAUTHORIZED', 'auth message required'),
      AUTH_TIMEOUT_MS,
    )

    const off = opts.bus.on((event) => {
      if (!authed) return
      if (subscribed && 'jobId' in event && !subscribed.has(event.jobId)) return
      send(event)
    })

    ws.on('message', (data) => {
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        count = 0
      }
      if (++count > MAX_MSGS_PER_SEC) return ws.close(4429, 'rate limited')
      let msg: WsClientMessage
      try {
        msg = JSON.parse(String(data)) as WsClientMessage
      } catch {
        return deny('JOB_INVALID', 'messages must be JSON')
      }
      if (!authed) {
        if (
          msg.type !== 'auth' ||
          typeof msg.token !== 'string' ||
          !safeEqual(msg.token, opts.token)
        ) {
          return deny('UNAUTHORIZED', 'invalid token')
        }
        authed = true
        clearTimeout(timer)
        return send({ type: 'auth.ok', protocol: PROTOCOL_VERSION })
      }
      if (msg.type === 'subscribe' && Array.isArray(msg.jobIds)) {
        subscribed ??= new Set()
        for (const id of msg.jobIds) subscribed.add(String(id))
      } else if (msg.type === 'unsubscribe' && Array.isArray(msg.jobIds)) {
        for (const id of msg.jobIds) subscribed?.delete(String(id))
      }
    })
    ws.on('close', () => {
      clearTimeout(timer)
      off()
    })
  }

  return wss
}
