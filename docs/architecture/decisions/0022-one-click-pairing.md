---
tags: [architecture, decision]
status: accepted
date: 2026-09-27
---

# ADR-0022: One-click pairing through the engine's approval page

**Status:** accepted. Amends [ADR-0006](0006-engine-transport.md): the planned `sublight://pair?token=…` custom-protocol handshake is replaced by an approval page the engine serves. The paste-token path stays.

## Context

The extension and the Player authenticate to the local engine with a bearer token ([Protocol §3](../../specification/03-Protocol.md#3-auth--hardening)). Until now the user had to run `pnpm engine:token` in a terminal and paste 64 hex characters into Options and into the Player. [M06](../../plan/milestones/06-Beta-Release.md) asks for pairing without a terminal.

The planned `sublight://` link needs the operating system to know that link type, which only an installer can register (three platforms, three mechanisms). The engine, on the other hand, already serves HTTP on loopback, and the browser already tells it where each request comes from (`Origin`).

## Decision

A device-code style flow, all on `127.0.0.1`:

1. **Request:** the extension (or the Player) calls `POST /v1/pair/request`. The engine accepts it only from an allowed origin (the extension's ID, the Player's origin) and answers `{ requestId, code, approveUrl }`. The code is 4 digits and the request lasts 5 minutes; at most 10 wait at once.
2. **Approve:** the client opens `approveUrl`, the engine's own page `/pair?request=…`. It names who asked ("The sublight browser extension"), shows the origin and the code, and offers Approve / Deny. The client shows the same code, so the user can tell it's the same request. The engine also logs the request with its URL.
3. **Decide:** the page posts `POST /v1/pair/decide`. The engine accepts that **only from its own origin** (`http://127.0.0.1:<port>`, `http://localhost:<port>`). The browser sets `Origin` and pages can't forge it, so no other website can approve. The page is served with `X-Frame-Options: DENY`, so it can't be framed to trick a click.
4. **Claim:** the client polls `POST /v1/pair/claim`. The engine answers only to the origin that asked, and hands the token over **once**, after approval.

In the extension, the service worker runs the flow, because a popup closes when the approval tab opens; the popup and Options show "Pair with the engine" and the code. The Player runs it itself, because its page stays open.

## Consequences

- Pairing is two clicks with no terminal. The e2e test "pairs in one click" covers it: request, same code on both sides, approve, claim, online.
- **The trust boundary is unchanged.** Anyone who can drive the local browser can already approve, just as anyone who can run `pnpm engine:token` can read the token. Another _website_ can't: it can neither request (origin not allowed), approve (not the engine's origin) nor claim (not the origin that asked).
- A malicious extension with a copied ID is out of scope, as it already was: the allowlist is by extension ID, and store builds get their own ID.
- Revoking is a token rotation: **Unpair every app** in Options, or `sublight-engine token --rotate`. Every client pairs again. There are no per-client tokens yet.

## Alternatives considered

- **`sublight://pair?token=`:** needs protocol registration per OS (an installer), and puts the token in a URL that can end up in history or logs.
- **Show the token on a local page for copy-paste:** still a paste, and any page the user opens on that origin could display it.
- **Trust on first use (the first client that asks gets the token):** a hostile page racing the real extension is exactly what the approval step prevents.
