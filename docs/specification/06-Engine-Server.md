---
tags: [specification, engine]
status: specified
updated: 2026-09-23
---

# 06 — Engine server

_The local Node process that owns AI. Everything here is defined against [Protocol](03-Protocol.md); the engine implements it._

## 1. Process & lifecycle

- Node 22, TypeScript, **Hono** (HTTP) + `ws` (WebSocket), bound to `127.0.0.1:17421`.
- Config: `~/.sublight/config.json` — `{ token, port, defaults: { asrModel, translateModel }, autoRetry, allowedOrigins, cacheLimits: { mediaBytes, uploadBytes }, whisper: { binary?, port, gpu: "auto"|"off", threads }, ffmpeg: { ffmpeg, ffprobe } }`; missing fields take defaults, a generated token is always persisted, an unreadable file is renamed aside. `pnpm engine:token` prints the token for manual pairing until M06.
- Start: read config → build services → serve HTTP + WS → recover jobs from the log. Workers spawn lazily **on the first job that needs them** (a missing whisper binary fails that job with `WORKER_UNAVAILABLE`, not the engine).
- Graceful shutdown: SIGTERM/SIGINT → mark `running` jobs `interrupted` → compact `jobs.jsonl` → stop whisper-server. A hard kill leaves an orphaned whisper-server; its pid file (`~/.sublight/run/whisper-server.pid`) lets the next start reap it, after checking `/proc/<pid>/cmdline` really is whisper-server.
- Autostart via user unit/LaunchAgent at [M06](../plan/milestones/06-Beta-Release.md).

## 2. GPU scheduling (the 4 GB budget)

- **One resident model at a time.** A state machine: `none → asr → translate → none`; a job of type B while A is resident either waits (queued) or triggers a swap after A's current job yields (between jobs, never mid-job).
- Swap: unload binary (kill whisper-server/llama-server or `--no-warm`) → load target → warm (e.g. llama `--preload`) → run.
- VRAM hints from NVML when available (`nvidia-smi` parse fallback) drive decisions: if free < model need → offload layers to CPU (`-ngl` fraction) with a `slow` flag surfaced in job logs; if even that fails → `GPU_OOM` retryable failure, engine retries once with `base` model. CPU-only fallback: engine uses a CPU build of whisper.cpp with no VRAM check.
- The budget table is [Requirements §4](../architecture/Requirements.md).
- **As built (M04):** one GPU slot shared by all GPU jobs; before a job loads its worker, `GpuResidency` stops the other one (whisper ↔ llama), so exactly one model is resident and swaps happen between jobs. `nvidia-smi` VRAM figures in health, `residentModel` = the loaded model id. Measured on the T1000 (desktop using ~0.7 GB): whisper-small ~0.85 GB; Qwen3-4B fully offloaded with a q8_0 KV cache ~2.9 GB. The llama worker tries full offload first and falls back to llama.cpp's `-ngl auto --fit on` when that can't load (VRAM taken by other apps); a `GPU_OOM` code for mid-job failures isn't needed yet.

## 3. Model manager (per [ADR-0016](../architecture/decisions/0016-model-licensing.md))

- **Manifest** (`apps/engine/src/models/manifest.ts`, pinned): `{ id, role, repo, revision, file, sha256, sizeBytes, vramClass, license, tasks? }` — `tasks` on ASR models lists `"transcribe"` and, for multilingual checkpoints, `"translate"` ([ADR-0018](../architecture/decisions/0018-whisper-translate-to-english.md)). Installed set = `models/installed.json` entries whose file is present at the pinned size.
- Install: stream download to `<file>.part` while hashing → abort past the pinned size → verify size + SHA-256 → atomic rename → registry update. Refuse on mismatch (part file deleted, state `error` with the reason); never execute downloaded files. Progress over WS `model.install.progress` (≈1% steps); concurrent installs of one model join.
- Removal: delete artifact, report freed bytes. (Evicting cached results made with the model is not needed: cache keys include the model id.)
- **Default install set = one ASR model only.** The translation LLM is installed on demand the first time a user picks a non-English target; English targets use Whisper `translate` and need nothing extra.
- Registry lists manifest models; UI shows `installed/model size/disk used` and a budget line (default 20 GB, warn at 80%).

## 4. ffmpeg (audio ingestion)

- `PUT /v1/media/:mediaId` → stream to a temp file under the upload cap → `ffprobe` (no audio stream → `AUDIO_UNSUPPORTED`) → normalize `-vn -ac 1 -ar 16000 -c:a pcm_s16le` (any codec/container, any channel layout) → SHA-256 of the **normalized** WAV → `media-cache/{sha256}.wav` + `{sha256}.json` sidecar `{ durationMs, normalizedBytes, sourceName, createdAt, lastUsedAt }`. The client's `mediaId` is an alias (`ids/`); the same audio in another container dedupes to one entry.
- Empty/silent audio (`volumedetect` mean < −60 dB) → `AUDIO_EMPTY` early failure (no ASR wasted).
- Very long inputs: normalize in one pass (16 kHz mono PCM is ~1.9 MB/min → 2 h ≈ 230 MB, fine); ASR chunks at 10-min boundaries internally with overlap handling (see [07 §1](07-ASR-And-Translation.md)).
- `GET /v1/media/:ref` (id or hash) returns the sidecar; `DELETE /v1/media/:hash` removes it and its aliases; LRU eviction by `lastUsedAt` down to `cacheLimits.mediaBytes` after each upload (never the upload just made).

### 4.1 Media resolve & relay (open-in-player)

The "Open in Sublight Player" flow ([ADR-0017](../architecture/decisions/0017-open-in-player.md), milestone [M05b](../plan/milestones/05b-Open-in-Player.md)) lets a page's video migrate into the Player; when the direct/manifest transports don't apply, the **engine owns fetching** the media (it has network + yt-dlp where the site is supported).

- `POST /v1/media/resolve { url, site? }` — probe/fetch a site URL:
  - Supported sites (yt-dlp) → extract best matching format (audio+video or video + separate audio), verify ≥ some minimum bitrate sanity, resolve metadata `{ mediaId, durationMs, title }`.
  - Direct URLs → probe via ffprobe over an HTTP range request; if reachable and media-like, return `{ kind: "direct-url", directUrl: url, durationMs, title }` without downloading.
  - Failure (auth-walled, geo, DRM, dead link) → structured error the player maps to honest copy ("can't reach this video from the engine"), never a silent hang.
  - The media is **stored like any upload** (`media-cache/{sha256}.wav` normalized) so captions reuse the local-file pipeline ([04 §9.4](04-Player-App.md#94-captioning-a-migrated-video)) with T₀ = 0.
- `GET /v1/relay/:mediaId` — byte proxy for the _original_ (non-normalized) media so the player can seek:
  - v1 (M05b): engine buffers the fetch to `media-cache/relay/{mediaId}.{ext}` with **"Preparing media…" progress** via WS (`relay.progress`), then serves `Range`-aware requests from disk.
  - v2: on-the-fly streaming with upstream `Range` passthrough (target: YouTube-sized files start playing within a few seconds).
  - Relay entries are LRU-evicted like media; re-resolve is cheap (`resolve` again → same `mediaId` from hash key).
- Security: resolve/relay follow the same auth + Origin/Host checks as everything else ([Protocol §3](03-Protocol.md#3-auth--hardening)); the engine only ever fetches what a _resolved_ payload from the extension asked for (no open proxy: relay ids are unguessable hashes, no arbitrary `GET /v1/relay?url=`).

## 5. Job runner

- Queue: priority classes (`interactive` > `batch`), FIFO within a class; in-process. One GPU slot (all ASR/translation), up to 4 concurrent non-GPU jobs.
- GPU slot enforced by [§2](#2-gpu-scheduling).
- States & persistence: [Protocol §5](03-Protocol.md#5-job-lifecycle--states). `jobs/jobs.jsonl` is append-only (`put` per job, `patch` per transition), replayed and compacted on start; results in `jobs/{id}.result.json`; long jobs checkpoint each ASR chunk in `jobs/{id}.chunks/` so a restart resumes after the last finished chunk.
- **Idempotency**: `Idempotency-Key` → the original job (replaying the key also re-queues it if it was left `interrupted`). **Cache**: `cacheKey` = pipeline version + media hash + model + task + language + max cue length; a hit creates a `done` job flagged `cached: true` that serves the earlier result.
- Cancellation: queued → `cancelled` at once; running → abort signal, checked between ASR chunks and passed to the whisper HTTP request. Retryable failures (worker crash/unavailable) run once more before `failed`.

## 6. Whisper worker (ASR)

- Binary: `pnpm engine:setup-whisper` builds `whisper-server` from whisper.cpp **v1.9.4, verified commit `927cfce3`**, with CUDA when `nvcc` is present (`-DCMAKE_CUDA_ARCHITECTURES=native`), into `~/.sublight/bin` with `whisper.json` (backend, SHA-256). Spawned on `127.0.0.1:17422` with `-m <model>`; `--no-gpu` for CPU builds or `whisper.gpu: "off"`. Health: poll `GET /health` until 200 (≤ 180 s model load). A different model means a restart; a dead process is respawned on the next job.
- Call: `POST /inference` multipart (`file`, `response_format=verbose_json`, `language`, `translate`, `temperature=0`) → segments with BPE tokens (`word`, `start`, `end`, `t_dtw`, `probability`) → words → cues by the shared rules in [07 §1](07-ASR-And-Translation.md) (engine imports cue construction from `core`). Word timing uses token `t0`/`t1`, not DTW — see [07 §1.2](07-ASR-And-Translation.md#12-segmentation-whispercpp-server-output).
- Language: `auto` per request unless the job pins one; after the first chunk the detected language is pinned for the remaining chunks. Whisper's language names map to codes via its own table (100 languages).
- Task: `params.task: "translate"` sets whisper's translate flag (any language → English). Cues come from segment timestamps; word timestamps are dropped for these runs ([07 §2.0](07-ASR-And-Translation.md#20-choosing-a-translation-path-adr-0018)). Refused with `JOB_INVALID` when the model's manifest `tasks` lacks `translate`.

## 7. Llama worker (translation)

- **Optional worker**: used for non-English targets, text-only tracks, or when the user sets a glossary/register ([ADR-0018](../architecture/decisions/0018-whisper-translate-to-english.md)); without the model a translate job is refused with `MODEL_NOT_INSTALLED` so the client can offer the install.
- Binary: `pnpm engine:setup-llama` builds `llama-server` from llama.cpp **b11174, verified commit `ed319feb`**, CUDA when available, no network features (`-DLLAMA_CURL=OFF`); `~/.sublight/bin/llama.json`.
- Model: `qwen3-4b-instruct` (Qwen3-4B-Instruct-2507, Q4_K_M, Apache-2.0, [ADR-0019](../architecture/decisions/0019-translator-qwen3-4b.md)).
- Spawn: `llama-server` on `127.0.0.1:17423` with `-c 4096 -np 1 --jinja --no-webui`; GPU: `-ngl all --fit off -fa on -ctk q8_0 -ctv q8_0`, falling back to `-ngl auto --fit on -fa on` for the session if that can't load. Measured: **29.7 tok/s** with full offload vs 9.6 tok/s with the automatic fit (which left layers on the CPU).
- Calls: OpenAI-compatible `POST /v1/chat/completions`, temperature 0.2, top_p 0.9, `max_tokens` ≈ 1.5 × source characters; speed from the response `timings`.
- Config: `llama: { binary?, port, gpu: "auto"|"off", threads, contextTokens }`.
- [07 §2](07-ASR-And-Translation.md) for the chunking/prompt/validation protocol the worker drives. Both model servers share one supervisor (`workers/server-process.ts`: spawn, health polling, pid-file orphan reaping, restart on crash).

## 7b. Live sessions (M05)

- `LiveHub` keeps one `LiveSession` per live job: PCM appended to `jobs/live/<id>.pcm` with a chunk index (sample ↔ wall time) and the playback anchors (wall time → media time). Audio may arrive before the queue starts the job.
- `liveRunner` (`gpu: true`, usually `interactive`): rolling-window passes, commit/draft split, media-time mapping, stop → refinement per playing stretch with the never-regress guard, 60 s idle timeout. Details in [08 §5](08-Audio-Capture.md#5-live-captioning-loop-as-built).

## 8. Observability

- Logs: JSONL to `~/.sublight/logs/engine.log` (rotate 10 MB × 5): startup, job state changes, `job.log` errors, model state; whisper-server's own output in `logs/whisper-server.log`. `job.log` events also go out over WS.
- `GET /v1/health` exposes GPU name/VRAM (`nvidia-smi`, cached 5 s), resident model id, running/queued jobs, media cache bytes.
- Metrics (simple counters in health): jobs total/done/failed, avg ASR realtime-factor, avg translation tok/s — the numbers that feed [checkpoints](../checkpoints/README.md).

## 9. Testing

- Unit/integration (`apps/engine/tests`): auth + origin matrix, routes over real services, WS auth/filtering, queue (priority, GPU serialization, idempotency, cache, cancel, retry, crash recovery), model install against a local server incl. a corrupted artifact, ffmpeg corpus, token→word mapping and chunk merging.
- Real ASR (`asr.integration.test.ts`): whisper-small on `tests/fixtures/jfk.wav`, onsets checked against energy onsets; skipped where the binary/model isn't installed (CI). Crash/resume verified by hand: SIGKILL mid-job → restart → orphan reaped, only the missing chunk re-run.
- ffmpeg corpus: stereo AAC, 5.1 PCM, 8 kHz phone audio, silence, video without audio, oversized uploads (generated with lavfi at test time).

## 10. Related

- [Protocol](03-Protocol.md) · [07 — ASR & translation](07-ASR-And-Translation.md) · [Deployment diagram](../architecture/diagrams/Deployment.md)
- ADRs [0004](../architecture/decisions/0004-local-engine-outside-extension.md) · [0005](../architecture/decisions/0005-engine-stack.md) · [0006](../architecture/decisions/0006-engine-transport.md) · [0007](../architecture/decisions/0007-whisper-model-matrix.md) · [0016](../architecture/decisions/0016-model-licensing.md) · [0018](../architecture/decisions/0018-whisper-translate-to-english.md)
