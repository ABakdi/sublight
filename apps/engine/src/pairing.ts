import { randomBytes, randomInt } from 'node:crypto'

/** A pairing request lives this long, approved or not. */
export const PAIRING_TTL_MS = 5 * 60 * 1000
/** At most this many requests waiting at once (a page can't flood the engine). */
const MAX_PENDING = 10

export type PairingState = 'pending' | 'approved' | 'denied' | 'claimed'

export interface PairingRequest {
  id: string
  /** Who asked: the extension or the Player (a known, allowed origin). */
  origin: string
  /** Shown on both sides so the user can tell it's the same request. */
  code: string
  state: PairingState
  createdAt: number
}

/**
 * One-click pairing (ADR-0022). The extension or the Player asks for a token;
 * the engine's own page (`/pair`) shows who asked and a code; the user
 * approves there, and only the origin that asked can then claim the token,
 * once. Only the engine's own origin can approve, so no other website can.
 */
export class PairingStore {
  private requests = new Map<string, PairingRequest>()

  request(origin: string, now = Date.now()): PairingRequest {
    this.prune(now)
    const pending = [...this.requests.values()].filter((r) => r.state === 'pending')
    if (pending.length >= MAX_PENDING) this.requests.delete(pending[0]!.id)
    const req: PairingRequest = {
      id: randomBytes(16).toString('hex'),
      origin,
      code: String(randomInt(0, 10_000)).padStart(4, '0'),
      state: 'pending',
      createdAt: now,
    }
    this.requests.set(req.id, req)
    return req
  }

  get(id: string, now = Date.now()): PairingRequest | null {
    this.prune(now)
    return this.requests.get(id) ?? null
  }

  decide(id: string, approve: boolean, now = Date.now()): PairingRequest | null {
    const req = this.get(id, now)
    if (!req || req.state !== 'pending') return null
    req.state = approve ? 'approved' : 'denied'
    return req
  }

  /**
   * The token goes out once, to the origin that asked, after approval:
   * `fresh` is true only for that one claim.
   */
  claim(
    id: string,
    origin: string,
    now = Date.now(),
  ): { request: PairingRequest; fresh: boolean } | null {
    const req = this.get(id, now)
    if (!req || req.origin !== origin) return null
    if (req.state !== 'approved') return { request: req, fresh: false }
    req.state = 'claimed'
    return { request: req, fresh: true }
  }

  private prune(now: number): void {
    for (const [id, r] of this.requests)
      if (now - r.createdAt > PAIRING_TTL_MS) this.requests.delete(id)
  }
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

/** Who's asking, in words: only origins known to be a Player are called one. */
export function describeOrigin(origin: string, players: readonly string[] = []): string {
  if (origin.startsWith('chrome-extension://')) return 'The sublight browser extension'
  if (players.includes(origin)) return 'The Sublight Player'
  return `The web page at ${origin}`
}

/** The engine's approval page: self-contained (no external resources), light and dark. */
export function pairingPage(req: PairingRequest | null, players: readonly string[] = []): string {
  const body = !req
    ? `<h1>Nothing to approve</h1><p>This pairing request has expired or was already answered. Start pairing again from sublight.</p>`
    : req.state !== 'pending'
      ? `<h1>Already ${req.state === 'denied' ? 'denied' : 'approved'}</h1><p>You can close this tab.</p>`
      : `<h1>Allow access to the sublight engine?</h1>
<p><b>${escape(describeOrigin(req.origin, players))}</b> wants to use the engine on this computer to caption and translate videos.</p>
<p class="origin">${escape(req.origin)}</p>
<p>Check that sublight shows the same code:</p>
<div class="code" data-code>${escape(req.code)}</div>
<div class="actions">
  <button id="approve" class="primary">Approve</button>
  <button id="deny">Deny</button>
</div>
<p id="result" role="status"></p>
<script>
  const decide = async (approve) => {
    for (const b of document.querySelectorAll('button')) b.disabled = true
    const res = await fetch('/v1/pair/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: ${JSON.stringify(req.id)}, approve }),
    })
    document.getElementById('result').textContent = res.ok
      ? approve ? 'Approved. You can close this tab: sublight is paired.' : 'Denied.'
      : 'That didn’t work: the request may have expired. Start pairing again.'
  }
  document.getElementById('approve').onclick = () => decide(true)
  document.getElementById('deny').onclick = () => decide(false)
</script>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair with sublight</title>
<style>
  :root { color-scheme: light dark; --bg: #f9fafb; --fg: #101828; --muted: #667085; --accent: #4f46e5; --card: #fff; --border: #e4e7ec }
  @media (prefers-color-scheme: dark) { :root { --bg: #09090b; --fg: #f4f4f5; --muted: #a1a1aa; --card: #18181b; --border: #27272a; --accent: #818cf8 } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box }
  main { max-width: 440px; width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px }
  h1 { font-size: 19px; margin: 0 0 12px }
  .origin { color: var(--muted); font-size: 12px; word-break: break-all }
  .code { font: 700 34px/1 ui-monospace, monospace; letter-spacing: 8px; text-align: center; padding: 14px; border: 1px dashed var(--border); border-radius: 10px; margin: 8px 0 16px }
  .actions { display: flex; gap: 10px }
  button { font: inherit; padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600 }
  button:disabled { opacity: .5; cursor: default }
</style></head>
<body><main>${body}</main></body></html>`
}
