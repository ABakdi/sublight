---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0013 — Engine API v1: REST jobs + WebSocket events, versioned JSON

**Status:** accepted

## Context

Both clients need the same operations: health/model status, create a transcription or translation job, monitor progress, cancel, get results, install models. The API is the contract between the engine and everything else; it must be typed (shared `packages/protocol`), versioned, and boring.

## Decision

- **REST + JSON** for requests/responses; **WebSocket (`/ws`)** for job progress events and logs.
- **Version prefix `/v1`** on all endpoints; the protocol package exports request/response types compiled with `tsc` so the client and server can't drift ([ADR-0001](0001-monorepo-layout.md)).
- Job semantics: `POST /v1/jobs` → `{ jobId }`; `GET /v1/jobs/:id` → status (`queued → running → done | failed | cancelled`), progress (0–1), partial results; `POST /v1/jobs/:id/cancel`; results under `GET /v1/jobs/:id/result`.
- **Idempotency keys** on job creation (retry-safe) and **content-hash dedupe** (identical audio+model+params → cached job result).
- Models: `GET /v1/models`, `POST /v1/models/{id}/install`, progress streamed over WS.
- Errors are typed: `{ code, message, retryable, details? }` — one `error` envelope everywhere, documented in [Spec 03](../../specification/03-Protocol.md).
- WS messages are discriminated unions: `job.progress`, `job.state`, `job.log`, `job.result` (final, replaces polling), `model.install.progress`.

## Consequences

**Good:** one contract, typed end-to-end; polling optional (WS is primary); versioned so engine can evolve without breaking old extensions; curl-able for debugging and tests.
**Cost:** WS lifecycle management in the service worker (reconnect, resume state via REST fallback); protocol must be designed once, carefully (M02).

## Alternatives considered

- **gRPC/Protobuf** — heavier, needs codegen; JSON + TS types is enough for localhost.
- **SSE-only** — uni-directional; WS gives client→server control (cancel) without extra endpoints.
- **No versioning** — rejected; engine and browser extensions update on different schedules.

## Links

- [Spec 03 — Protocol](../../specification/03-Protocol.md)
- [Packages: protocol](../../architecture/decisions/0001-monorepo-layout.md)
- [Plan M02 — engine](../../plan/milestones/02-Local-ASR-Engine.md)
