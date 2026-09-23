---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M04 — Translation pipeline

**Goal:** meaning-preserving translation into any target language, produced locally, mapped 1:1 onto subtitle timings.

## Scope

- llama.cpp integration in the engine (spawn/health/restart; `chat/completions`).
- Translation jobs: input = a subtitle track (+ target lang + optional glossary + style rules) → output = translated track (same timings).
- **Paragraph chunking** algorithm + prompt template + validation/fallback per [ADR-0009](../../architecture/decisions/0009-translation-stack.md).
- Bilingual data support: overlay can show source + translation simultaneously (data already supports it — this milestone adds the job plumbing and a first render pass; polish is M09).
- Language/script support note: translation engine choice per language; NLLB alternative installable.
- Progress + partial delivery over WS; full-film translation as a backgroundable job.

## Tasks

- [ ] **M04.1** — llama.cpp manager in engine: pinned binary, spawn, health, VRAM swap coordination with whisper ([ADR-0005](../../architecture/decisions/0005-engine-stack.md), [Spec 06 §2](../../specification/06-Engine-Server.md)).
- [ ] **M04.2** — `POST /v1/jobs {type: translate, track, targetLang, glossary?}`; result track with identical cue boundaries.
- [ ] **M04.3** — Sentence boundary detection (SBD) + paragraph grouper (gap > 1.5 s or sentence end; ≤ 1500 chars; no speaker-boundary splits).
- [ ] **M04.4** — Prompt template v1 (numbered source lines, preserve `[SPEAKER]`, no commentary, output only the numbered lines) + **validation**: line-count match → map; else retry once (re-prompt with fewer lines) → else proportional re-split.
- [ ] **M04.5** — Glossary UI in player (name → fixed translation) stored in project; injected into prompts.
- [ ] **M04.6** — Bilingual render mode in overlay: source (dim) + translation (bright) stacking rule documented in [Spec 05 §7](../../specification/05-Overlay-Rendering.md).
- [ ] **M04.7** — Translation QA pack: 3 language pairs × 10 paragraphs hand-checked for meaning; failures recorded → prompt iteration (and mirrored in [checkpoints](../../checkpoints/README.md)).

## Acceptance criteria

1. A 10-min track translates in < 5 min on T1000 (3B Q4) with per-paragraph progress visible.
2. Line mapping is 1:1 (100% of output cues map to input cues by construction; validation catches every mismatch).
3. Meaning check: > 90% of paragraphs "meaning-preserving" per the QA pack (subjective but recorded); names/glossary correct.
4. Bilingual render shows both languages with distinct styling; switching between tracks is instant.
5. NLLB install works for a rare language (e.g. Swahili) as the fallback path.

## Dependencies

- [M02](02-Local-ASR-Engine.md) (engine/jobs), [M03](03-Transcription-Pipeline.md) (tracks exist in player).
- ADRs: [0009](../../architecture/decisions/0009-translation-stack.md), [0016](../../architecture/decisions/0016-model-licensing.md).

## Open questions

- Default target language list for Beta 1 (suggest: EN, ES, DE, FR, AR, JA, ZH, RU + "any" via manual code).
- Whether to add a "style" voice toggle (formal/casual) — nice, cheap, but may wait for M09.

## Related

- [Spec 07 §2 — translation pipeline](../../specification/07-ASR-And-Translation.md) · [Spec 05 §7 — bilingual mode](../../specification/05-Overlay-Rendering.md)
- [ADR-0009](../../architecture/decisions/0009-translation-stack.md)