---
tags: [specification, protocol]
status: specified
updated: 2026-09-23
---

# 03 — Protocol

_The wire contract between clients (extension, player) and the engine. Typed in `packages/protocol`; this document is the human-readable reference. Version prefix `/v1`._

## 1. Base & transport

- Base URL: `http://127.0.0.1:17421` (loopback only).
- REST: JSON over HTTP. WebSocket: `ws://127.0.0.1:17421/ws` for events.
- Every request must carry `Authorization: Bearer <token>`; WS must auth in the first message or the socket is closed immediately ([Auth & hardening](#3-auth--hardening)).
- Content-Type `application/json` unless uploading (then `application/octet-stream` with metadata headers).

## 2. Endpoints

### Health & meta

| Endpoint          | Response                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`  | `{ status: "online", version, engineUptimeMs, gpu: { available, name, vramTotal, vramFree }, activeJobs }` |
| `GET /v1/version` | `{ engine: semver, protocol: 1 }`                                                                          |

### Models

| Endpoint                      | Notes                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models`              | `{ models: ModelInfo[], diskUsedBytes }`; each `{ id, role, name, sizeBytes, vramClass, license, tasks?, installed, state: not-installed \| downloading \| installed \| error, progress, error? }` |
| `POST /v1/models/:id/install` | `202 { ok, model }`; download runs in the background, progress via WS `model.install.progress`, end state via `model.state`                                                                        |
| `POST /v1/models/:id/remove`  | removes the artifact; `{ ok, freedBytes }`                                                                                                                                                         |
| `GET /v1/models/:id`          | single model detail                                                                                                                                                                                |

### Jobs (the core)

| Endpoint                   | Notes                                    |
| -------------------------- | ---------------------------------------- |
| `POST /v1/jobs`            | body + idempotency-key header (below)    |
| `GET /v1/jobs/:id`         | state, progress, partial result, error   |
| `POST /v1/jobs/:id/cancel` | best-effort cancel of queued/running job |
| `GET /v1/jobs/:id/result`  | full result (cues/tracks)                |
| `GET /v1/jobs`             | list, filter by `status`                 |

Job creation bodies (discriminated by `type`):

```jsonc
// transcribe
{ "type": "transcribe",
  "mediaHash": "sha256:…",       // or "mediaId" from upload
  "model": "whisper-small",
  "params": { "language": null,   // null = auto-detect (source language)
              "task": "transcribe",  // or "translate" = any language → English (ADR-0018)
              "maxCueDurationMs": 7000 } }

// translate (LLM path — non-English targets, or text-only tracks; Spec 07 §2.0)
{ "type": "translate",
  "track": { …SubtitleTrack },    // cues + words inlined
  "model": "qwen2.5-3b-instruct",
  "targetLang": "de",
  "glossary": [ { "source": "VLC", "target": "الفي إل سي" } ],
  "style": "casual" | "neutral" | "formal" }
```

### Media upload & relay

| Endpoint                                   | Notes                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /v1/media/:mediaId`                   | streaming upload (octet-stream, `X-Source-Name`, `X-Source-MediaHash?`); engine normalizes to 16 kHz mono PCM, stores under `sha256`, responds `{ mediaHash, durationMs, normalizedBytes }` |
| `GET /v1/media/:ref`                       | metadata for a media id or `sha256:` hash: `{ mediaHash, durationMs, normalizedBytes, sourceName, createdAt, lastUsedAt }`                                                                  |
| `DELETE /v1/media/:mediaHash`              | free cache (and the id aliases pointing at it)                                                                                                                                              |
| `POST /v1/media/resolve` _(M05b, planned)_ | `{ url, site? }` → engine fetches/probes the URL (fetch rules / yt-dlp) → `{ mediaId, durationMs, title, kind: "relay"                                                                      | "direct-url", directUrl? }`; used by "Open in Sublight Player" |
| `GET /v1/relay/:mediaId` _(M05b, planned)_ | streaming byte proxy with `Range` support so the player can seek a relayed video; v1 buffers to disk before serving, v2 streams on the fly                                                  |

### Auth pairing (v1 handshake)

| Endpoint                              | Notes                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/pair/info` (unauthenticated) | returns the **presence** of pairing (`{ requiresToken: true }`) and a short-lived pairing nonce when the token isn't set — used by the `sublight://pair?token=` flow ([M06](../plan/milestones/06-Beta-Release.md)) |

## 3. Auth & hardening

_Verified by tests + the [security baseline](../audits/Security-Baseline-Plan.md)._

1. Token: 32 random bytes, hex; stored in `config.json`; accepted only via `Authorization` header (never cookies, never query).
2. Comparison in constant time.
3. `Host` header must be `127.0.0.1:17421` or `localhost:17421` — **defeats DNS-rebinding**.
4. CORS: explicit allowlist only — `chrome-extension://ehgdbfcecgkljnpmednociabmmjemfkf` (the unpacked dev build, pinned by its manifest key), `http://localhost:5173`, `http://127.0.0.1:5173` (dev player), plus `config.allowedOrigins` for store/packaged IDs and the packaged player origin. Never `*`, no reflection. Host and Origin are checked on **every** route, including the unauthenticated pairing probe.
5. No `content-type: text/html` responses (XSS-by-CORS confusion guard); error responses are JSON.
6. Uploads size-capped (default 20 GB, configurable) and streamed — no full-buffering.
7. WS: auth in first message; unauthenticated connections dropped in < 1 s.

## 4. WS event envelope

```ts
type WsEvent =
  | { type: 'job.state'; jobId: string; state: JobState } // queued|running|done|failed|cancelled|interrupted
  | { type: 'job.progress'; jobId: string; progress: number; detail?: string } // 0..1
  | { type: 'job.partial'; jobId: string; draft: SubtitleTrack } // live captions & chunk-commits
  | { type: 'job.log'; jobId: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'model.install.progress'; modelId: string; progress: number }
  | { type: 'model.state'; modelId: string; state: ModelState }
  | { type: 'engine.gpu'; vramFree: number; residentModel: string | null }
```

Client → engine messages: `{ type: "auth", token }` first (reply `{ type: "auth.ok", protocol }`, or `{ type: "error" }` + close code 4401), then optionally `{ type: "subscribe" | "unsubscribe", jobIds }`. Without a subscription a client receives every event; with one, only events for those jobs plus model/engine events. More than 20 messages/s closes the socket (4429). The upgrade itself passes the same Host/Origin checks as HTTP.

Clients subscribe per job; the engine fans out. Reconnect rule: on socket loss, clients re-`GET /v1/jobs/:id` (REST is the source of truth; WS is an accelerator).

## 5. Job lifecycle & states

```
queued → running → done
  │         │
  │         ├─→ failed { retryable, code, message, details? }
  │         └─→ cancelled
  └─(engine restart)─→ interrupted → (re-queue on wake) → queued
```

- **Job summary** (`GET /v1/jobs/:id`, list items, `POST` response `202`): `{ id, type, state, progress, detail?, priority, cached?, error?, createdAt, updatedAt }`. `cached: true` = answered from an identical earlier job (same media + model + params).
- **Result** (`GET /v1/jobs/:id/result`, `409` until `done`): `{ id, state: "done", tracks, language?, realtimeFactor? }`. The engine sets `track.projectId = ""`; clients assign their project on import.
- **Idempotency**: `Idempotency-Key: <uuid>` header on `POST /v1/jobs`; replay returns the original job (same id). Combined with media hash, re-runs after client errors never double-process.
- **Retryable failures**: worker crash, transient GPU OOM (auto-retry with offload hint), ffmpeg timeout. Non-retryable: bad input, model missing, checksum failure.
- **Persistence**: every state transition appends to `jobs.jsonl`; on restart, `running` jobs are marked `interrupted` and re-queued when a client re-issues with the same idempotency key OR automatically for `retryable: true` (config `autoRetry: true` default).

## 6. Errors (single envelope)

```jsonc
{ "error": { "code": "JOB_FAILED", "message": "…", "retryable": false, "details": {} } }
```

Codes: `UNAUTHORIZED`, `BAD_ORIGIN`, `MODEL_NOT_INSTALLED`, `MODEL_INSTALL_FAILED`, `MEDIA_TOO_LARGE`, `AUDIO_EMPTY`, `AUDIO_UNSUPPORTED`, `JOB_NOT_FOUND`, `JOB_INVALID`, `JOB_FAILED`, `WORKER_UNAVAILABLE`, `GPU_OOM`, `INTERNAL`.

## 7. Limits (v1 defaults)

| Limit                                               | Value                                        | Configurable |
| --------------------------------------------------- | -------------------------------------------- | ------------ |
| Upload size                                         | 20 GB                                        | yes          |
| Job duration                                        | none (batch ok)                              | —            |
| In-flight GPU jobs                                  | 1 ASR + 1 translation **share** one GPU slot | no (policy)  |
| Concurrent non-GPU jobs (translation chunk fetches) | 4                                            | yes          |
| WS message rate                                     | 20 msg/s per client                          | internal     |

## 8. Conventions

- Cue/track payloads in requests/responses are **the** `packages/core` types — validated both sides.
- Time values are ms integers; never floats on the wire.
- New protocol versions add `/v2` rather than mutating `/v1`; engine supports the last two versions (deprecation window = 2 releases).

## 9. Related

- [06 — Engine server](06-Engine-Server.md) (how the server implements this) · [ADR-0013](../architecture/decisions/0013-engine-api.md) · [ADR-0006](../architecture/decisions/0006-engine-transport.md)
- [Security baseline audit](../audits/Security-Baseline-Plan.md)
