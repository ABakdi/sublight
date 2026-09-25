---
tags: [plan, milestone]
status: done
updated: 2026-09-25
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

- [x] **M02.1** — Protocol types in `packages/protocol`: Job, JobState, Progress, ModelId, requests/responses; versioned envelope; tests that client/server types compile against each other.
- [x] **M02.2** — Auth: random token at first run; `Authorization: Bearer`; constant-time compare; Host check; CORS allowlist (extension + player origins).
- [x] **M02.3** — `/v1/health`, `/v1/models` (installed/available/state), `/v1/models/:id/install` with WS progress.
- [x] **M02.4** — Job queue: states, priorities (interactive > batch), cancel, idempotency, resume-from-log on restart; unit tests.
- [x] **M02.5** — Media ingest: streaming `PUT /v1/media/:id`; ffmpeg → 16 kHz mono PCM WAV; `sha256` store; eviction policy.
- [x] **M02.6** — whisper.cpp manager: binary pinned+checksummed, spawned on demand, parallel-safe restart, `/transcribe` call with word timestamps; parse into `Segments[]`; map to cues (initial gap/merge rules).
- [x] **M02.7** — `POST /v1/jobs {type: transcribe, audio, model, params}` returning cues + words; WS `job.progress` and `job.result`.
- [x] **M02.10** — Whisper `translate` task ([ADR-0018](../../architecture/decisions/0018-whisper-translate-to-english.md)): `params.task: "translate"` → English track built from segment timestamps; manifest `tasks` gate (`JOB_INVALID` on models that can't translate).
- [x] **M02.8** — CLI ergonomics: `pnpm engine dev`, `start`, `--once` (run one job, exit), log to file; config in `~/.sublight/config.json`.
- [x] **M02.9** — Engine tests: auth rejection matrix, queue fairness, crash-restart recovery, ffmpeg edge files (mono/stereo/5.1, short, silent).

## Acceptance criteria

1. `GET /v1/health` responds with token; every endpoint rejects bad/missing tokens; a `Host: evil.com` request is refused; CORS never `*`.
2. Installing `whisper small` from the manifest verifies SHA-256; a corrupted artifact refuses to install.
3. A 10-min test clip transcribes end-to-end with word timestamps; `GET /v1/jobs/:id/result` contains cues with integer-ms bounds.
4. Kill the engine mid-job, restart → job resumes or re-queues without double-processing (idempotency key honored).
5. Two concurrent job requests never run ASR+ASR at the same time if the GPU budget says so (serialization works).
6. Running the same audio+model twice returns cached result (no re-transcribe).
7. A non-English clip with `task: "translate"` returns an English track (`kind: "translation"`, integer-ms cues, no `words`); the same request on a model without `translate` is refused with `JOB_INVALID`.

## Mini self-check (M02 close, on the target T1000)

- [x] AC1 — every data route and the WS reject missing/bad tokens; `Host: evil.com` refused on every route (incl. the pairing probe and the WS upgrade); CORS is an explicit allowlist (`app.test.ts`, `routes.test.ts`, `ws.test.ts`).
- [x] AC2 — whisper-small installed through `POST /v1/models/whisper-small/install` with SHA-256 verified; a corrupted artifact is refused and leaves no file (`models.test.ts`).
- [x] AC3 — an 11-min German clip (LibriVox, public domain) transcribed end to end: 185 cues / 1,564 words, integer-ms, non-overlapping, ≈ 8× realtime.
- [x] AC4 — engine SIGKILLed after chunk 1 of 2 → restart re-queued the job (autoRetry), reaped the orphaned whisper-server, re-ran only chunk 2 (9 s), seamless at 10:00; replaying the idempotency key returned the same job.
- [x] AC5 — two jobs submitted together never ran at once (live check + `queue.test.ts`).
- [x] AC6 — same audio + model + params answered from cache in 27 ms (`cached: true`).
- [x] AC7 — German speech with `task: "translate"` → English `translation` track, no `words`; `translate` on large-v3-turbo refused with `JOB_INVALID`.

## Notes

- whisper.cpp **v1.9.4** is built from a verified commit by `pnpm engine:setup-whisper` (CUDA 13.4 + GCC 16 on the target, `sm_75`). There's no Linux release binary to pin instead.
- **Word timing uses token t0/t1, not DTW**: measured, DTW onsets were 200–400 ms late on this build ([Spec 07 §1.2](../../specification/07-ASR-And-Translation.md#12-segmentation-whispercpp-server-output)). Real audio also exposed words split across segments, a `core` `wrapWords` bug (overflow word alone on a line), and orphan words in translate cues. All fixed with tests.
- `pnpm engine:transcribe <file> [--translate] [--language xx] [--out f.srt]` is the one-shot mode (M02.8 "--once"): in-process, prints SRT.
- Found while pinning the manifest: **Qwen2.5-3B-Instruct is not Apache-2.0**. Resolved in M04: replaced by Qwen3-4B-Instruct-2507 (Apache-2.0, [ADR-0019](../../architecture/decisions/0019-translator-qwen3-4b.md)).
- Carried to later milestones: ASR ↔ LLM model swap and VRAM offload / `GPU_OOM` retry (M04, with the LLM worker); cue segmentation quality (breaks at reader pauses can leave very short cues; M03 refinement); a real recorded sync corpus (M03).

## Dependencies

- [M00 Foundations](00-Foundations.md).
- ADRs: [0004](../../architecture/decisions/0004-local-engine-outside-extension.md), [0005](../../architecture/decisions/0005-engine-stack.md), [0006](../../architecture/decisions/0006-engine-transport.md), [0007](../../architecture/decisions/0007-whisper-model-matrix.md), [0008](../../architecture/decisions/0008-word-level-timestamps.md), [0013](../../architecture/decisions/0013-engine-api.md), [0016](../../architecture/decisions/0016-model-licensing.md), [0018](../../architecture/decisions/0018-whisper-translate-to-english.md).

## Open questions

- ~~whisper.cpp server flags for word timestamps~~ — resolved: default token timestamps, no `--dtw` (Spec 06 §6, 07 §1.2).
- First-run model download UX (CLI prompt vs. on-demand install from client) — the API supports on-demand install; the UX lands with the player integration (M03).

## Related

- [Spec 03 — Protocol](../../specification/03-Protocol.md) · [Spec 06 — Engine Server](../../specification/06-Engine-Server.md) · [Spec 07 §1 — ASR](../../specification/07-ASR-And-Translation.md)
- First engine **security checkpoint**: see [security baseline plan](../../audits/Security-Baseline-Plan.md).
