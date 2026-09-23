---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M02 — Local ASR engine

**Goal:** the Sublight Engine is real: authenticated HTTP+WS API, pinned model installs, job queue, and **whisper.cpp producing word-level timestamps**. This is the spine of the whole product — everything after this milestone talks to the engine.

## Scope

- Engine server ([ADR-0006](../../architecture/decisions/0006-engine-transport.md)): token auth, Origin+Host checks, CORS allowlist, `/v1/health`.
- Protocol ([Spec 03](../../specification/03-Protocol.md)): REST + WS events, typed via `packages/protocol`, versioned.
- Job system: create/cancel/status/resume; queue with **GPU serialization**; idempotency keys; `jobs.jsonl` persistence.
- Model manager: pinned manifest ([ADR-0016](../../architecture/decisions/0016-model-licensing.md)), install/progress/checksum verify, `~/.sublight/models`.
- whisper.cpp integration: spawn/health/restart; upload audio → 16 kHz mono PCM via bundled ffmpeg → transcribe with **word timestamps** ([ADR-0008](../../architecture/decisions/0008-word-level-timestamps.md)).
- Media cache: content-hash dedupe of normalized audio (to make re-runs free).

## Tasks

- [ ] **M02.1** — Protocol types in `packages/protocol`: Job, JobState, Progress, ModelId, requests/responses; versioned envelope; tests that client/server types compile against each other.
- [ ] **M02.2** — Auth: random token at first run; `Authorization: Bearer`; constant-time compare; Host check; CORS allowlist (extension + player origins).
- [ ] **M02.3** — `/v1/health`, `/v1/models` (installed/available/state), `/v1/models/:id/install` with WS progress.
- [ ] **M02.4** — Job queue: states, priorities (interactive > batch), cancel, idempotency, resume-from-log on restart; unit tests.
- [ ] **M02.5** — Media ingest: streaming `PUT /v1/media/:id`; ffmpeg → 16 kHz mono PCM WAV; `sha256` store; eviction policy.
- [ ] **M02.6** — whisper.cpp manager: binary pinned+checksummed, spawned on demand, parallel-safe restart, `/transcribe` call with word timestamps; parse into `Segments[]`; map to cues (initial gap/merge rules).
- [ ] **M02.7** — `POST /v1/jobs {type: transcribe, audio, model, params}` returning cues + words; WS `job.progress` and `job.result`.
- [ ] **M02.8** — CLI ergonomics: `pnpm engine dev`, `start`, `--once` (run one job, exit), log to file; config in `~/.sublight/config.json`.
- [ ] **M02.9** — Engine tests: auth rejection matrix, queue fairness, crash-restart recovery, ffmpeg edge files (mono/stereo/5.1, short, silent).

## Acceptance criteria

1. `GET /v1/health` responds with token; every endpoint rejects bad/missing tokens; a `Host: evil.com` request is refused; CORS never `*`.
2. Installing `whisper small` from the manifest verifies SHA-256; a corrupted artifact refuses to install.
3. A 10-min test clip transcribes end-to-end with word timestamps; `GET /v1/jobs/:id/result` contains cues with integer-ms bounds.
4. Kill the engine mid-job, restart → job resumes or re-queues without double-processing (idempotency key honored).
5. Two concurrent job requests never run ASR+ASR at the same time if the GPU budget says so (serialization works).
6. Running the same audio+model twice returns cached result (no re-transcribe).

## Dependencies

- [M00 Foundations](00-Foundations.md).
- ADRs: [0004](../../architecture/decisions/0004-local-engine-outside-extension.md), [0005](../../architecture/decisions/0005-engine-stack.md), [0006](../../architecture/decisions/0006-engine-transport.md), [0007](../../architecture/decisions/0007-whisper-model-matrix.md), [0008](../../architecture/decisions/0008-word-level-timestamps.md), [0013](../../architecture/decisions/0013-engine-api.md), [0016](../../architecture/decisions/0016-model-licensing.md).

## Open questions

- whisper.cpp server flags for word timestamps on our build (locked during M02.6; record the exact flag set in the spec).
- First-run model download UX (CLI prompt vs. on-demand install from client).

## Related

- [Spec 03 — Protocol](../../specification/03-Protocol.md) · [Spec 06 — Engine Server](../../specification/06-Engine-Server.md) · [Spec 07 §1 — ASR](../../specification/07-ASR-And-Translation.md)
- First engine **security checkpoint**: see [security baseline plan](../../audits/Security-Baseline-Plan.md).