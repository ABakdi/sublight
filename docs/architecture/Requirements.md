---
tags: [architecture, requirements]
status: accepted
updated: 2026-09-23
---

# Requirements

_The constraints sublight is built under. Hardware targets, software requirements, model constraints, and the non-functional targets (accuracy, latency, privacy) the whole design is measured against._

---

## 1. Target environment (the actual machine)

| Resource | Value                                                                            | Design consequence                                                                                                             |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CPU      | Intel i7-9750H, 6 cores / 12 threads, **AVX2**                                   | AVX2 enables fast CPU-only inference fallback; whisper.cpp/llama.cpp are AVX2-optimized.                                       |
| RAM      | **32 GB** DDR4                                                                   | Whole Whisper + LLM can run **CPU-offloaded**; browser + engine + OS all fit comfortably.                                      |
| GPU      | **NVIDIA Quadro T1000, 4 GB VRAM** (Turing, 896 CUDA cores, **no tensor cores**) | Fits one quantized model at a time (see §4). No tensor-core speedup → 4-bit/quantized LLM inference is fine, fp16 ASR is fine. |
| Disk     | SSD preferred; ~5 GB models + cache                                              | Models are downloaded on demand, cached by content hash.                                                                       |
| OS       | Linux (primary dev), Windows/macOS (target for release packaging)                | Portability goals documented in [ADR-0005](./decisions/0005-engine-stack.md).                                                  |

> **Assumption checked:** "quadro t100, 4 GB VRAM" is read as **Quadro T1000**. If the actual card differs (e.g. Quadro RTX 1000), the model matrix in §4 stays valid — nothing changes structurally, only timing.

## 2. Software requirements

| Layer              | Requirement                                                      | Notes                                                                                                               |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Browsers           | **Chromium** and **Brave** (primary test targets), Firefox later | Chromium-first per [ADR-0003](./decisions/0003-manifest-v3-chromium-first.md).                                      |
| Extension          | **Manifest V3**, WXT framework                                   | Service-worker constraints shape the architecture ([ADR-0004](./decisions/0004-local-engine-outside-extension.md)). |
| Runtime            | **Node.js ≥ 22 LTS** (engine + build tooling)                    | Single language: TypeScript everywhere.                                                                             |
| Engine AI runtimes | **whisper.cpp**, **llama.cpp**, **ffmpeg** (static binaries)     | See [ADR-0005](./decisions/0005-engine-stack.md).                                                                   |
| Frontend           | React 19, TypeScript 5.x, Vite, Tailwind CSS 4                   | [ADR-0002](./decisions/0002-frontend-stack.md).                                                                     |

## 3. Functional requirements

Grouped; detailed contracts live in the [Specification](../specification/README.md).

### F1 — Playback

- F1.1 Play local video files in the Sublight Player (drag & drop / file picker).
- F1.1b Play **any web video** in the Sublight Player: the extension hands the page's video over in one click ([ADR-0017](./decisions/0017-open-in-player.md)).
- F1.2 Play online videos in _any_ page; overlay subtitles without breaking the host player.
- F1.3 Standard controls, seek, pause, resume, speed, fullscreen; keyboard shortcuts.
- F1.4 Persist playback position and project state across sessions.

### F2 — Captioning (online)

- F2.1 One-click "capture & caption" on any supported site with a visible `<video>`.
- F2.2 Live captions during playback (subtitles appear a few seconds behind the audio) _and_ a batch/refined pass producing final word-synced cues.
- F2.3 Works on YouTube (including SPA navigation), embedded iframe players, Vimeo, and generic pages.
- F2.4 Survives pause/seek/speed changes during capture (see [Spec 08](../specification/08-Audio-Capture.md)).

### F3 — Captioning in the Player (local files and relayed web videos)

- F3.1 Transcribe a local video end-to-end without real-time constraints.
- F3.2 Audio extracted and normalized by the engine (16 kHz mono PCM), not by the browser.

### F4 — Accuracy & sync

- F4.1 **Word-level timestamps** with median onset offset ≤ 250 ms after refinement (target), no drift accumulation over a 2 h video (≤ 500 ms total).
- F4.2 Meaning-preserving translation: rated fluent for dialog by the project owner, proper nouns/glossary respected. English target: Whisper `translate` with no extra model; other targets: local LLM ([ADR-0018](./decisions/0018-whisper-translate-to-english.md)).
- F4.3 Speech recognition Word Error Rate ≤ 15% on clear single-speaker audio with default `small` model; better with the large-v3 (turbo) models.

### F5 — Subtitle management

- F5.1 Multiple language tracks per video/transcript.
- F5.2 Styles: color, background, size, font, outline/shadow, position, alignment, opacity — user-adjustable and persisted.
- F5.3 Export **SRT** (VTT planned).
- F5.4 Manual sync adjustment (offset nudge) + per-cue editing at a later milestone.

### F6 — Privacy & operation

- F6.1 Zero data leaves the machine (except optional model downloads).
- F6.2 Engine runs as a user-launched or autostart local process; clients talk over `127.0.0.1` with a bearer token.
- F6.3 All AI models open source, permissive or acceptably-licensed, installed locally ([ADR-0016](./decisions/0016-model-licensing.md)).

### F7 — Future (documented, not yet built)

- F7.1 Firefox port. — F7.2 Subtitle editing suite. — F7.3 **Language-learning integration** with the sibling tool: dual-language overlay, click-a-word lookups, vocabulary export, saved snippets. Stubbed in the data model now ([Spec 02](../specification/02-Data-Model.md)).

## 4. Model constraints & the default model matrix

VRAM budget is **4 GB, one model resident at a time**. The engine serializes GPU work (swap models between jobs) — see [Spec 06](../specification/06-Engine-Server.md) and [ADR-0007](./decisions/0007-whisper-model-matrix.md).

| Role              | Default                                        | VRAM (approx)                        | Quality                                    | When to use                                                                                              |
| ----------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ASR               | Whisper `small` (ggml)                         | ~2.0–2.5 GB                          | Good (WER ~10–15% clean audio)             | Default balance                                                                                          |
| ASR (fast)        | Whisper `base`                                 | ~1 GB                                | OK                                         | Short clips, quick drafts, weak machine                                                                  |
| ASR (best)        | **large-v3-turbo** q5 (ggml)                   | ~1.5 GB                              | Near-large                                 | Recommended when quality matters                                                                         |
| ASR (max)         | `medium` / `large-v3`, 5-bit (q5)              | ~1.5–2.5 GB                          | Best                                       | Slow; offline files; both can translate                                                                  |
| Translation → EN  | Whisper `translate` (the ASR model)            | 0 extra                              | Serviceable, literal-ish                   | Any language → English; no extra download ([ADR-0018](./decisions/0018-whisper-translate-to-english.md)) |
| Translation       | **Qwen3-4B-Instruct-2507** Q4_K_M (Apache-2.0) | ~3 GB (2.5 GB weights + q8 KV cache) | Fluent, contextual; ~29 tok/s on the T1000 | Non-English targets; installed on demand ([ADR-0019](./decisions/0019-translator-qwen3-4b.md))           |
| Translation (alt) | NLLB-200-distilled-600M                        | ~1.2 GB                              | Literal-ish, 200 languages                 | Not shipped: CC-BY-NC (non-commercial)                                                                   |

**Concurrency rule:** ASR and translation never run simultaneously on GPU; the job queue serializes GPU jobs and swaps models. CPU-only mode (no CUDA build) is a supported degraded mode but slow.

## 5. Non-functional requirements

| NFR                       | Target                                                                                                | Where it's reasoned about                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Latency (live)**        | First caption within ~3–8 s of speech (rolling-window transcription)                                  | [Spec 07 §1](../specification/07-ASR-And-Translation.md), [Spec 08](../specification/08-Audio-Capture.md) |
| **Latency (translation)** | A subtitle paragraph translated within ~5–30 s; full-movie translation in a background job            | [ADR-0009](./decisions/0009-translation-stack.md)                                                         |
| **ASR speed**             | ≥ 2× realtime on T1000 (base/small), so live captioning keeps up easily                               | [Requirements §4](#4-model-constraints--the-default-model-matrix)                                         |
| **Privacy**               | No outbound traffic except model downloads and (optional) yt-dlp                                      | [Security audit plan](../audits/Security-Baseline-Plan.md)                                                |
| **Reliability**           | Engine crash doesn't lose completed work (jobs resumable); UI degrades gracefully when engine is down | [Spec 10](../specification/10-Non-Goals-And-Failure-Modes.md)                                             |
| **Testability**           | Chromium + Brave covered by Playwright; sync accuracy measured against a ground-truth corpus          | [Plan M00](../plan/milestones/00-Foundations.md)                                                          |
| **Offline**               | Everything except model download and (optional) yt-dlp works without internet                         | [ADR-0016](./decisions/0016-model-licensing.md)                                                           |

## 6. Out of scope (explicitly)

- DRM-protected streams (Netflix, Prime, etc.) — technically blocked, legally messy.
- Remote/cloud inference — contradicts the local-first principle.
- Speech diarization (who spoke when) — nice-to-have, deferred.
- Auto-translation of non-speech text (burned-in captions) — separate OCR problem, deferred to language-learning milestone planning.
