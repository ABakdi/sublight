---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0006 — Engine transport: localhost HTTP + WebSocket with a bearer token

**Status:** accepted

## Context

Clients (extension background, player app) must talk to the engine over localhost. Options:

1. **Native messaging** (`chrome.runtime.connectNative`) — the "official" secure channel: OS-level registration of a native host, no open port, no token dance. Cost: a native host manifest + installer per OS/browser, Firefox's implement differs slightly, and the _player app_ (a web page, not an extension) **cannot use native messaging at all** — it would need yet another channel.
2. **Localhost HTTP server** — one port, one API for both clients, trivially scriptable and testable. Cost: an open localhost port is a security surface (any website can attempt to reach it — DNS rebinding, CSRF-style calls).

sublight has **two** client types, one of which (the player web app) has no native-messaging path. This is the deciding constraint.

## Decision

- The engine exposes **HTTP (REST) + WebSocket (`/ws`)** on `127.0.0.1:17421` only.
- Auth: **random 128-bit bearer token** stored in the engine config; required on every request as `Authorization: Bearer <token>` (header, **not** cookie — cookies are what CSRF/DNS-rebinding abuse).
- Token provisioning: engine writes the token to its config; the player/extension pair via a **paste-token UI** and later a **`sublight://pair?token=…` custom-protocol handshake** (M06).
- Hardening (all enforced, audited in the [security baseline](../../audits/Security-Baseline-Plan.md)):
  - Bind `127.0.0.1` only; reject `Host` headers that aren't `127.0.0.1[:port]`/`localhost[:port]` (defeats DNS rebinding).
  - CORS allowlist: `chrome-extension://<id>` (built + dev IDs) and player origins (`http://localhost:5173`, `http://127.0.0.1:5173`, later the packaged player origin). Never `*`.
  - No requests from any other origin; no `Access-Control-Allow-Origin` reflection.
  - Request body/upload size limits; token comparison in constant time.
- **Native messaging is deferred** to packaging time (M06+) as an optional hardening; ADR will be revisited if we ship a packaged engine.

## Consequences

**Good:** one API serves the extension and the player; engine is `curl`-able and headlessly testable; WS gives bidirectional progress/events for free.
**Cost:** we carry the localhost security burden consciously — the constant-token + Origin++Host checks above are the price, and must survive audits.

## Alternatives considered

- **Native messaging for the extension + separate player channel** — two transports, duplicated auth; rejected.
- **Unix socket** — Linux-only; Windows target kills it; rejected.
- **mDNS/discovery** — overkill locally for v1; noted for future multi-device scope (out).

## Links

- [Spec 03 — Protocol](../../specification/03-Protocol.md)
- [ADR-0013](0013-engine-api.md) · [Spec 06 — Engine Server](../../specification/06-Engine-Server.md)
- [Security baseline audit](../../audits/Security-Baseline-Plan.md)
