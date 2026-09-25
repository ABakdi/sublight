---
tags: [plan, milestone]
status: done
updated: 2026-09-25
---

# M04 — Translation pipeline

**Goal:** meaning-preserving translation into any **non-English** target language, produced locally, mapped 1:1 onto subtitle timings. English targets are already covered by Whisper `translate` from [M02](02-Local-ASR-Engine.md) ([ADR-0018](../../architecture/decisions/0018-whisper-translate-to-english.md)); this milestone adds the LLM path and the routing between the two.

## Scope

- llama.cpp integration in the engine (spawn/health/restart; `chat/completions`); the LLM is an **on-demand install**, not part of the default model set.
- Routing ([Spec 07 §2.0](../../specification/07-ASR-And-Translation.md#20-choosing-a-translation-path-adr-0018)): English + audio → Whisper `translate`; everything else → LLM.
- Translation jobs: input = a subtitle track (+ target lang + optional glossary + style rules) → output = translated track (same timings).
- **Paragraph chunking** algorithm + prompt template + validation/fallback per [ADR-0009](../../architecture/decisions/0009-translation-stack.md).
- Bilingual data support: overlay can show source + translation simultaneously (data already supports it — this milestone adds the job plumbing and a first render pass; polish is M09).
- Language/script support: Qwen3-4B covers 119 languages. The NLLB alternative is **not shipped**: its license is non-commercial ([ADR-0019](../../architecture/decisions/0019-translator-qwen3-4b.md)).
- Progress + partial delivery over WS; full-film translation as a backgroundable job.

## Tasks

- [x] **M04.1** — llama.cpp manager in engine: pinned binary, spawn, health, VRAM swap coordination with whisper ([ADR-0005](../../architecture/decisions/0005-engine-stack.md), [Spec 06 §2](../../specification/06-Engine-Server.md)).
- [x] **M04.2** — `POST /v1/jobs {type: translate, track, targetLang, glossary?}`; result track with identical cue boundaries.
- [x] **M04.3** — Sentence boundary detection (SBD) + paragraph grouper (gap > 1.5 s or sentence end; ≤ 1500 chars; no speaker-boundary splits).
- [x] **M04.4** — Prompt template v1 (numbered source lines, preserve `[SPEAKER]`, no commentary, output only the numbered lines) + **validation**: line-count match → map; else retry once (re-prompt with fewer lines) → else proportional re-split.
- [x] **M04.5** — Glossary UI in player (name → fixed translation) stored in project; injected into prompts.
- [x] **M04.6** — Bilingual render mode in overlay: source (dim) + translation (bright) stacking rule documented in [Spec 05 §7](../../specification/05-Overlay-Rendering.md).
- [x] **M04.7** — Translation QA pack: 3 language pairs × 10 paragraphs hand-checked for meaning; failures recorded → prompt iteration (and mirrored in [checkpoints](../../checkpoints/README.md)).
- [x] **M04.8** — Player target-language picker routes per Spec 07 §2.0; first non-English pick offers the LLM install with its size.

## Acceptance criteria

1. A 10-min track translates in < 5 min on T1000 (3B Q4) with per-paragraph progress visible.
2. Line mapping is 1:1 (100% of output cues map to input cues by construction; validation catches every mismatch).
3. Meaning check: > 90% of paragraphs "meaning-preserving" per the QA pack (subjective but recorded); names/glossary correct.
4. Bilingual render shows both languages with distinct styling; switching between tracks is instant.
5. NLLB install works for a rare language (e.g. Swahili) as the fallback path.

## Mini self-check (M04 close, on the target T1000)

- [x] AC1 — 10 min of German transcript → English in **166.7 s** (< 5 min), per-paragraph progress in the job and the player.
- [x] AC2 — 1:1 by construction: numbered lines validated, halves retry, then duration re-split flagged `lowConfidence`. Real runs: 0 low-confidence in 10 min de → en; 1 in a 4-min de → fr player run.
- [~] AC3 — first-pass QA ([checkpoint](../../checkpoints/M04-Translation-QA.md)): English ~12/14, French ~13/16, Arabic ~10/16 lines meaning-preserving on dense literary German. **> 90 % not met** for that text into French/Arabic; dialogue lines are fine. The owner rating is still to do.
- [x] AC4 — bilingual render: source dimmed above the translation, toggled per track, verified in the browser.
- [—] AC5 — NLLB dropped (non-commercial license); rare languages rely on Qwen3's coverage.

## Notes

- Model: **Qwen3-4B-Instruct-2507** (Apache-2.0) replaces Qwen2.5-3B (research license) — [ADR-0019](../../architecture/decisions/0019-translator-qwen3-4b.md). llama.cpp b11174 built from a verified commit (`pnpm engine:setup-llama`).
- Speed: full GPU offload with flash attention and a q8_0 KV cache runs at 29.7 tok/s vs 9.6 with llama.cpp's automatic fit; the worker falls back to the fit when full offload can't load.
- First QA run had 24/182 low-confidence cues: fragment cues ("Weitere", "Kafka") got merged by the model. Fixed at both ends: cue construction now folds fragments into their neighbour (never across a sentence end) and the prompt tells the model fragments stay on their own lines → 0/149.
- Also fixed on the way: `core` could drop words when merging long cues; the translate form crashed the player with a zustand selector that returned a new `[]` on every render (render test added).
- English targets still use Whisper `translate` from the audio when possible (ADR-0018); a glossary or register choice routes to the LLM.

## Dependencies

- [M02](02-Local-ASR-Engine.md) (engine/jobs), [M03](03-Transcription-Pipeline.md) (tracks exist in player).
- ADRs: [0009](../../architecture/decisions/0009-translation-stack.md), [0018](../../architecture/decisions/0018-whisper-translate-to-english.md), [0016](../../architecture/decisions/0016-model-licensing.md).

## Open questions

- ~~Default target language list~~ — 16 common languages in the picker (en, de, fr, es, it, pt, nl, ru, ar, tr, ja, zh, ko, hi, pl, uk).
- ~~Register toggle~~ — shipped (neutral / casual / formal).
- Optional larger translation model for quality (e.g. Qwen3-8B, Apache-2.0, partial offload) — see the QA checkpoint.

## Related

- [Spec 07 §2 — translation pipeline](../../specification/07-ASR-And-Translation.md) · [Spec 05 §7 — bilingual mode](../../specification/05-Overlay-Rendering.md)
- [ADR-0009](../../architecture/decisions/0009-translation-stack.md)
