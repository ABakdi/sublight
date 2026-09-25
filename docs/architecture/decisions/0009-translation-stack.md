---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0009 — Translation: local LLM over paragraph chunks (not per-cue)

**Status:** accepted — **amended by [ADR-0018](0018-whisper-translate-to-english.md)**: for an **English** target with audio available, Whisper's `translate` task is used instead of the LLM; the LLM below covers every other target and is installed on demand.

## Context

Requirement F4.2: translations must be **accurate in meaning**, not word-for-word, and must fit back into subtitle timings. Three candidate approaches:

1. **Whisper `translate` task (audio→English only)** — built-in, but only English and loses the original; quality is mediocre; rejected.
2. **NLLB-200** (CTranslate2, ~600 MB) — dedicated translation, 200 languages, fast, low VRAM, but literal, no style/context, and CC-BY-NC license.
3. **Open-weight LLM via llama.cpp** (Qwen2.5-3B-Instruct Q4_K_M, ~2.5 GB) — fluent, contextual, handles speaker markers and idioms. _(Originally recorded as Apache-2.0; the 3B size is actually under the Qwen Research License — see [ADR-0016](0016-model-licensing.md), open question for M04.)_ QR: fits in 4 GB if ASR is not resident concurrently.

Translating **cue-by-cue** destroys context ("Hi! … What? …" translated per 2 s slice reads terribly). The right unit is a **paragraph** — a group of cues between long gaps or sentence boundaries (~50–300 words).

## Decision

- **Default translator: a local LLM** (Qwen2.5-3B-Instruct, GGUF Q4_K_M) via llama.cpp's OpenAI-compatible server.
- **Chunking algorithm:** cues → sentences (SBD) → group into paragraphs ≤ ~1500 chars / ≤ N=3 subtitle lines per prompt → translate whole paragraph against a strict prompt (no explanations, numbered source lines, preserve `[SPEAKER]` markers and non-speech tags) → **validate** returned line count == expected → map 1:1 back to cues; on mismatch, retry once or fall back to proportional re-split ([Spec 07 §2](../../specification/07-ASR-And-Translation.md)).
- **Glossary:** user-editable term table injected into the prompt (proper nouns, technical terms).
- **NLLB-200** stays as an alternative runtime for low-VRAM machines and rare languages where the 3B LLM underperforms; it's a model-picker choice, not a parallel codepath ([Model manager](../../specification/06-Engine-Server.md)).
- **Bilingual mode** (source + translation interleaved) is a rendering concern of the overlay ([Spec 05](../../specification/05-Overlay-Rendering.md)), enabled by keeping both tracks.

## Consequences

**Good:** fluent, meaning-preserving translation; glossary gives user control over names; per-paragraph prompts are fast enough (5–30 s each); 3B Q4 model means ~10–20 tok/s on the T1000 — a 90-min film translates in minutes as a background job.
**Cost:** LLM prompt hygiene matters (transcripts are untrusted data — prompt-injection is treated as a security concern, [audit plan](../../audits/Security-Baseline-Plan.md)); quality varies by language pair (documented in checkpoints per language); VRAM must be swapped with ASR.

## Alternatives considered

- **Whisper translate** — rejected here as the _only_ translator (English-only); later adopted for the English target by [ADR-0018](0018-whisper-translate-to-english.md).
- **Bigger LLM (7B+) on CPU offload** — too slow for interactive use on T1000; documented as an advanced option for batch-only translation.
- **Cloud LLM** — privacy violation; rejected.

## Links

- [Spec 07 §2 — translation pipeline](../../specification/07-ASR-And-Translation.md)
- [ADR-0016 — model licensing](0016-model-licensing.md) · [ADR-0018 — Whisper translate for →English](0018-whisper-translate-to-english.md)
- [Plan M04 — Translation pipeline](../../plan/milestones/04-Translation-Pipeline.md)
