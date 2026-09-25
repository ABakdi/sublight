---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0007 — Whisper model matrix for a 4 GB VRAM GPU

**Status:** accepted

## Context

The target GPU holds **4 GB VRAM** with no tensor cores (Quadro T1000). The Whisper family spans ~0.4 GB (tiny) to ~10 GB (large-v3 fp16). Accuracy scales with size; so does VRAM. We can also offload layers to the 32 GB system RAM (slow) or run CPU-only (AVX2, ~2–4× realtime on the i7 for `small`). A single "best" model is wrong — the right model depends on whether we're live-captioning (need realtime+), batch-captioning a local file (offline, can be slow), or fighting noisy audio.

## Decision

A **model matrix**, selectable per job with sensible defaults:

| Model (manifest id)         | Artifact (ggml, pinned)         | VRAM (approx) | Speed on T1000                              | Translate | Use                                            |
| --------------------------- | ------------------------------- | ------------- | ------------------------------------------- | --------- | ---------------------------------------------- |
| `whisper-base`              | `ggml-base.bin` (148 MB)        | ~0.5 GB       | fastest                                     | yes       | Quick drafts, weak machines, live fallback     |
| **`whisper-small`**         | `ggml-small.bin` (488 MB)       | **~0.85 GB**  | **~8× realtime** (measured: 10 min in 76 s) | yes       | **Default**: accuracy/latency sweet spot       |
| `whisper-medium-q5`         | `ggml-medium-q5_0.bin` (539 MB) | ~1.5 GB       | slower                                      | yes       | More accurate, still fits the GPU              |
| `whisper-large-v3-turbo-q5` | `ggml-large-v3-turbo-q5_0.bin`  | ~1.5 GB       | near-small speed                            | **no**    | Best speed/quality for transcription           |
| `whisper-large-v3-q5`       | `ggml-large-v3-q5_0.bin` (1 GB) | ~2.5 GB       | slow                                        | yes       | Max accuracy for offline files                 |
| CPU-only (no GPU)           | any                             | 0             | 0.5–2× realtime                             | —         | Degraded-but-works mode (`whisper.gpu: "off"`) |

> **Corrected 2026-09-25 (M02):** the first version of this table named `distil-large-v3-turbo`, which doesn't exist. The real options were `distil-large-v3` (English-only output) and `large-v3-turbo`; the manifest ships the turbo checkpoint, 5-bit quantized. Quantized (`q5`) medium/large checkpoints replace the CPU-offload rows: they fit in 4 GB. Speed and VRAM for `small` are measured on the target machine; the others are estimates until a checkpoint measures them.

Rules:

- **One model resident at a time.** ASR and translation never contend for VRAM ([Spec 06](../../specification/06-Engine-Server.md) model swap).
- fp16 **off** for ASR on Turing (no tensor cores → fp16 runs on CUDA cores at ~2× fp32; still fine for `small`).
- **Translate capability** ([ADR-0018](0018-whisper-translate-to-english.md)): only the multilingual `base` / `small` / `medium` / `large-v3` checkpoints support Whisper's `translate` task (any language → English). `*.en`, distil and turbo checkpoints don't; the manifest records `tasks` per model and the engine refuses `translate` on a model without it.
- `medium`+ only when the job is offline and the user accepts the wait; surfaced in the UI as "slow but most accurate".

## Consequences

**Good:** honest speed/quality dial; quality-minded users get turbo or a quantized large model; weak machines still work; v1 ships sensible defaults.
**Cost:** model manager must handle multiple ASR models + swap; disk budget grows (each ggml file is ~0.5–1.5 GB); UI must explain the tradeoff without overwhelming.

## Alternatives considered

- **Only `small`** — simplest, but leaves quality on the table for offline files; rejected.
- **Only `large-v3` offloaded** — unworkable for live captioning; rejected.
- **Cloud transcription** — contradicts privacy; rejected.

## Links

- [Requirements §4 — model matrix](../../architecture/Requirements.md)
- [Spec 07 — ASR pipeline](../../specification/07-ASR-And-Translation.md) · [Spec 08 — Model manager (in 06)](../../specification/06-Engine-Server.md)
- [ADR-0009](0009-translation-stack.md) · [ADR-0018](0018-whisper-translate-to-english.md)
