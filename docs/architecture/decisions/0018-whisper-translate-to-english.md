---
tags: [architecture, decision]
status: accepted
date: 2026-09-25
---

# ADR-0018 — Whisper `translate` for any→English; the LLM becomes optional

**Status:** accepted — amends [ADR-0009](0009-translation-stack.md) (the LLM stays the translator for every non-English target)

## Context

Whisper has a built-in `translate` task: it listens to speech in any of its ~99 languages and writes **English** text directly. [ADR-0009](0009-translation-stack.md) rejected it because it cannot produce any other target language. That's true, but it throws away a free win: **English is the most common target**, and for that target Whisper translate needs **no second model, no model swap, no extra download** — the ASR model already resident on the GPU does it.

Facts that bound the decision:

1. **English output only.** `translate` is audio → English. It cannot do English → German, Arabic → French, etc. Any non-English target still needs a text translator.
2. **Not every checkpoint can translate.** The multilingual `base` / `small` / `medium` / `large-v3` models can. The English-only `*.en` models cannot; `distil-large-v3` outputs English transcripts only; `large-v3-turbo` was fine-tuned on transcription only and translates poorly. The engine must know which models support `translate`.
3. **Timing is segment-level, not word-level.** The English words Whisper writes don't correspond one-to-one with spoken source words, so word timestamps from a `translate` run are not meaningful. Cue boundaries come from Whisper's segment timestamps, which still track the audio (unlike text translation, which has to inherit timings from a source track).
4. **Quality.** For dialog, Whisper translate is serviceable but more literal than an instruction-tuned LLM with a glossary. It has no glossary and no register control.

## Decision

- **Routing rule (engine + player):**
  - Target **English**, audio available (local file, relayed page video, or captured tab audio) → **Whisper `translate`** with the resident ASR model. No LLM needed.
  - Target **any other language**, or translating an existing text track with no audio (topology C), or the user asked for glossary/register control → **LLM translator** per [ADR-0009](0009-translation-stack.md).
- **The LLM is optional.** It is not installed by default. The model manager offers it on demand the first time a user picks a non-English target ("Translating to German needs the translation model — 2.5 GB. Install?"). A user who only ever wants English subtitles never downloads it.
- **Protocol:** a transcribe job gains `params.task: "transcribe" | "translate"` (default `"transcribe"`). `task: "translate"` produces a track with `kind: "translation"`, `language: "en"`, `derivedFrom: { sourceLanguage }` (no `trackId` — it was derived from audio, not from a track).
- **Model capability flag:** the model manifest records `tasks: ["transcribe", "translate"]` per ASR model. The engine rejects `task: "translate"` on a model that can't do it with `JOB_INVALID` and suggests `small`.
- **Bilingual (source + English):** run both tasks over the same cached audio. Both tracks are timed against the audio, so they pair cleanly in the overlay.

## Consequences

**Good:** English subtitles for any language with one model and zero extra download; no ASR↔LLM VRAM swap for the most common case; the LLM moves off the critical path of Beta 1 for English-target users.
**Cost:** two translation paths to test (Whisper and LLM); the English track has segment-level (coarser) timing and no glossary; bilingual source+English costs two ASR passes; the UI must explain why some targets need an extra download.

## Alternatives considered

- **Whisper translate only, drop the LLM** — rejected: breaks the "any language" promise (F4.2); only English would be reachable.
- **LLM only (ADR-0009 as written)** — rejected: forces a 2.5 GB download and a model swap even for the most common target.
- **Text-translate the transcript to English via the LLM** — kept as the path when the user wants glossary control, but not the default for English.

## Links

- Amends [ADR-0009 — Translation stack](0009-translation-stack.md) · relates to [ADR-0007 — Whisper model matrix](0007-whisper-model-matrix.md)
- [Spec 07 §2.0 — choosing a translation path](../../specification/07-ASR-And-Translation.md#20-choosing-a-translation-path-adr-0018) · [Spec 03 — Protocol](../../specification/03-Protocol.md)
- [M02](../../plan/milestones/02-Local-ASR-Engine.md) (translate flag in the whisper worker) · [M04](../../plan/milestones/04-Translation-Pipeline.md) (LLM path, on-demand install)
