---
tags: [specification, engine]
status: specified
updated: 2026-09-23
---

# 06 — Engine server

_The local Node process that owns AI. Everything here is defined against [Protocol](03-Protocol.md); the engine implements it._

## 1. Process & lifecycle

- Node 22, TypeScript, **Hono** (HTTP) + `ws` (WebSocket), bound to `127.0.0.1:17421`.
- Config: `~/.sublight/config.json` — `{ token, ports, defaults: { asrModel, translateModel }, autoRetry, cacheLimits }`.
- Start: read config → health-check binaries (whisper/llama/ffmpeg exist + checksums) → serve. Lazy-spawn workers **on first job of that type**.
- Graceful shutdown: SIGTERM → mark `running` jobs `interrupted` → flush `jobs.jsonl` → kill workers.
- Autostart via user unit/LaunchAgent at [M06](../plan/milestones/06-Beta-Release.md).

## 2. GPU scheduling (the 4 GB budget)

- **One resident model at a time.** A state machine: `none → asr → translate → none`; a job of type B while A is resident either waits (queued) or triggers a swap after A's current job yields (between jobs, never mid-job).
- Swap: unload binary (kill whisper-server/llama-server or `--no-warm`) → load target → warm (e.g. llama `--preload`) → run.
- VRAM hints from NVML when available (`nvidia-smi` parse fallback) drive decisions: if free < model need → offload layers to CPU (`-ngl` fraction) with a `slow` flag surfaced in job logs; if even that fails → `GPU_OOM` retryable failure, engine retries once with `base` model. CPU-only fallback: engine uses a CPU build of whisper.cpp with no VRAM check.
- The budget table is [Requirements §4](../architecture/Requirements.md).

## 3. Model manager (per [ADR-0016](../architecture/decisions/0016-model-licensing.md))

- **Manifest** (`models.manifest.json`, pinned): `{ id, role, repo, revision, file, sha256, sizeBytes, vramClass, license, params? }`. Installed set = files in `~/.sublight/models/` validated against manifest.
- Install: stream download → verify SHA-256 → move into place (atomic rename) → state update. Refuse on mismatch; never execute downloaded files.
- Removal: delete artifact + evict dependent cache entries (size freed reported).
- Registry lists manifest models; UI shows `installed/model size/disk used` and a budget line (default 20 GB, warn at 80%).

## 4. ffmpeg (audio ingestion)

- `PUT /v1/media` → temp file → probe (`ffprobe` duration, codec) → normalize: `-ar 16000 -ac 1 -c:a pcm_s16le` (stereo→mono downmix, any codec/container) → store `~/.sublight/media-cache/{sha256}.wav` + sidecar `{durationMs, sourceName}`.
- Empty/silent audio (`volumedetect` mean < −60 dB) → `AUDIO_EMPTY` early failure (no ASR wasted).
- Very long inputs: normalize in one pass (16 kHz mono PCM is ~1.9 MB/min → 2 h ≈ 230 MB, fine); ASR chunks at 10-min boundaries internally with overlap handling (see [07 §1](07-ASR-And-Translation.md)).
- Delete media (`DELETE /v1/media/:hash`), eviction LRU across the cache dir.

## 5. Job runner

- Queue: FIFO with priority classes (interactive live-caption jobs > batch transcribe > batch translate); `p-queue`-style, in-process.
- GPU slot enforced by [§2](#2-gpu-scheduling).
- States & persistence: [Protocol §5](03-Protocol.md#5-job-lifecycle--states); `jobs.jsonl` append-only; snapshotting result payloads as files (`jobs/{id}.json`) for crash recovery.
- **Idempotency**: hash(idempotency-key) → job id map on disk; dedupe by `mediaHash`+`model`+`params` → same result (cache hit).
- Cancellation: cooperative — ASR chunk boundaries, per-paragraph in translation; subprocess killed only if unresponsive > 30 s.

## 6. Whisper worker (ASR)

- Spawns `whisper-server` (CUDA build on target; CPU build fallback) on `127.0.0.1:17422` with word-timestamp flags; health-checked (ping) every job; auto-restart with backoff on crash.
- Call: POST `/transcribe` (16 kHz PCM WAV) → JSON: segments `[ { start, end, text, tokens:[{text, t0, t1}] } ]` → **mapped to cues & words** by the shared rules in [07 §1](07-ASR-And-Translation.md) (engine imports cue-construction from `core`).
- Language: `--language auto` default; explicit override param supported.

## 7. Llama worker (translation)

- Spawns `llama-server` on `127.0.0.1:17423` (model per translate job's `model`, GGUF Q4_K_M default `qwen2.5-3b-instruct`); OpenAI-compatible chat endpoint.
- [07 §2](07-ASR-And-Translation.md) for the chunking/prompt/validation protocol the worker drives; a *translator adapter* interface (`translate(paragraphLines, meta) → lines`) keeps NLLB/CTranslate2 a swappable alternative (same interface, different impl — a future `translate-nllb` worker).

## 8. Observability

- Logs: JSONL to `~/.sublight/logs/engine.log` (rotate 10 MB × 5); `job.log` events forwarded over WS.
- `GET /v1/health` exposes GPU memory, resident model, queue depth, cache size.
- Metrics (simple counters in health): jobs total/done/failed, avg ASR realtime-factor, avg translation tok/s — the numbers that feed [checkpoints](../checkpoints/README.md).

## 9. Testing

- Integration suite: spin engine with temp config → protocol asserts (auth rejects, job lifecycle, cancel, resume, caching).
- Worker fault injection: kill whisper mid-job → retryable failure → restart.
- GPU budget simulation: stub NVML to force offload/queue behavior.
- ffmpeg corpus: stereo/5.1/mono, 8 kHz phone audio, 48 kHz music, empty, truncated files.

## 10. Related

- [Protocol](03-Protocol.md) · [07 — ASR & translation](07-ASR-And-Translation.md) · [Deployment diagram](../architecture/diagrams/Deployment.md)
- ADRs [0004](../architecture/decisions/0004-local-engine-outside-extension.md) · [0005](../architecture/decisions/0005-engine-stack.md) · [0006](../architecture/decisions/0006-engine-transport.md) · [0007](../architecture/decisions/0007-whisper-model-matrix.md) · [0016](../architecture/decisions/0016-model-licensing.md)