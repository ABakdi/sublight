---
tags: [specification, index]
status: active
updated: 2026-09-23
---

# Specification

_This is **how the system works**, in component-level detail: the pieces, their interfaces, their failure modes, and how they relate. The [Architecture](../architecture/README.md) decides *what*; the Specification says *exactly* what each thing does.*

## Reading order

1. [01 — System overview](01-System-Overview.md) — the map: components, relationships, runtime topologies.
2. [02 — Data model](02-Data-Model.md) — the nouns: projects, tracks, cues, words, storage.
3. [03 — Protocol](03-Protocol.md) — the verbs between engine and clients.
4. Pick your component: [04 Player](04-Player-App.md) · [05 Overlay](05-Overlay-Rendering.md) · [06 Engine](06-Engine-Server.md) · [07 ASR & translation](07-ASR-And-Translation.md) · [08 Audio capture](08-Audio-Capture.md) · [09 Extension](09-Browser-Extension.md).
5. [10 — Non-goals & failure modes](10-Non-Goals-And-Failure-Modes.md) — what we deliberately don't do, and how everything degrades.

## Spec index

| § | Doc | Key contents |
|---|---|---|
| 01 | [System overview](01-System-Overview.md) | Component map, relationships, three runtime topologies, trust boundaries |
| 02 | [Data model](02-Data-Model.md) | `SubtitleProject`, `SubtitleTrack`, `SubtitleCue`, `SpeechWord`; JSON schema; SRT/VTT/SSA mapping; storage layout; study-mode data |
| 03 | [Protocol](03-Protocol.md) | HTTP + WS contract, auth, errors, jobs, models, limits |
| 04 | [Player app](04-Player-App.md) | Playback, file access, project UI, captioning flow, editor, export |
| 05 | [Overlay rendering](05-Overlay-Rendering.md) | Shadow DOM rendering, style schema, positioning, karaoke & bilingual modes, accessibility |
| 06 | [Engine server](06-Engine-Server.md) | Lifecycle, GPU scheduling, model manager, ffmpeg, caches, jobs, logging |
| 07 | [ASR & translation](07-ASR-And-Translation.md) | Whisper pipeline, sync/anchoring math, refinement, paragraph translation, prompts |
| 08 | [Audio capture](08-Audio-Capture.md) | Sources, chunking, VAD, pause/seek semantics, error matrix |
| 09 | [Browser extension](09-Browser-Extension.md) | MV3 structure, content scripts, SPA, overlay mount, popup/options, permissions |
| 10 | [Non-goals & failure modes](10-Non-Goals-And-Failure-Modes.md) | Explicit non-goals; failure matrix with detection/impact/mitigation |

## Status markers used

- `specified` — written here and stable (may still be `planned` in the [plan](../plan/README.md)).
- `implemented` — code exists; the spec is the ground truth for changes.
- `planned` / `deferred` — agreed as *what*, not yet *when*.

## Glossary

| Term | Meaning |
|---|---|
| Cue | One subtitle entry: `{startMs, endMs, text, words[]?}` |
| Track | A `SubtitleTrack`: a language + ordered cues (+ optional source info) |
| Project | `SubtitleProject`: video reference + tracks + project settings + style overrides |
| Word | `SpeechWord { word, startMs, endMs, confidence? }` — ASR-granularity atom |
| Live captions | Draft cues rendered while watching (rolling-window ASR) |
| Refinement | Post-capture re-transcription that replaces drafts with final cues |
| T₀ / δ | Capture-start anchor / fine offset — see [07 §1](07-ASR-And-Translation.md) |
| Engine | The local Node inference server (`127.0.0.1:17421`) |
| Media hash | `sha256` of normalized audio; cache + dedupe key |

## How specs change

Small changes: edit here. Anything structural → propose an **[ADR](../architecture/Decisions.md)** *first*, then update the spec. Reality after releases → **[checkpoints](../checkpoints/README.md)**; fixes land back here.