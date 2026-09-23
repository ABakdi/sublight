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

| Model | VRAM (approx) | Speed on T1000 | Use |
|---|---|---|---|
| `base` | ~1 GB | ~6–10× realtime | Quick drafts, shorts, weak-machines, live fallback |
| **`small`** | ~2.0–2.5 GB | ~2–4× realtime | **Default** — accuracy/latency sweet spot |
| `distil-large-v3-turbo` | ~1.5 GB | ~4–8× realtime | **Best quality default** where users opt in; near-large accuracy at small speed |
| `medium` / `large-v3` | 4 GB+ → CPU-offloaded layers | slow (0.3–1× R) | Offline batch only; max accuracy for local files |
| CPU-only (no GPU) | 0 VRAM | 0.5–2× realtime | Degraded-but-works mode, e.g. no CUDA build |

Rules:
- **One model resident at a time.** ASR and translation never contend for VRAM ([Spec 06](../../specification/06-Engine-Server.md) model swap).
- fp16 **off** for ASR on Turing (no tensor cores → fp16 runs on CUDA cores at ~2× fp32; still fine for `small`).
- `medium`+ only when the job is offline and the user accepts the wait; surfaced in the UI as "slow but most accurate".

## Consequences

**Good:** honest speed/quality dial; quality-minded users get distil; weak machines still work; v1 ships sensible defaults.
**Cost:** model manager must handle multiple ASR models + swap; disk budget grows (each ggml file is ~0.5–1.5 GB); UI must explain the tradeoff without overwhelming.

## Alternatives considered

- **Only `small`** — simplest, but leaves quality on the table for offline files; rejected.
- **Only `large-v3` offloaded** — unworkable for live captioning; rejected.
- **Cloud transcription** — contradicts privacy; rejected.

## Links

- [Requirements §4 — model matrix](../../architecture/Requirements.md)
- [Spec 07 — ASR pipeline](../../specification/07-ASR-And-Translation.md) · [Spec 08 — Model manager (in 06)](../../specification/06-Engine-Server.md)
- [ADR-0009](0009-translation-stack.md)