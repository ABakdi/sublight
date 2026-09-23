---
tags: [plan, index]
status: active
updated: 2026-09-23
---

# Plan

_What we build, in what order, and how we know each step is done. Every milestone links to the specs it implements and the decisions it relies on._

**Current milestone:** [M00 — Foundations](milestones/00-Foundations.md) *(documentation phase — this vault)*

---

## Milestone roadmap at a glance

| M | Milestone | Theme | Depends on | Links |
|---|---|---|---|---|
| **M00** | Foundations | Monorepo, tooling, CI, test harness, docs | — | [milestone](milestones/00-Foundations.md) |
| **M01** | Player core | React player, local files, overlay rendering, SRT import/export | M00 | [milestone](milestones/01-Player-Core.md) · [spec 04](../specification/04-Player-App.md) · [spec 05](../specification/05-Overlay-Rendering.md) |
| **M02** | Local ASR engine | Engine server, protocol, whisper.cpp ASR, job queue | M00 | [milestone](milestones/02-Local-ASR-Engine.md) · [spec 06](../specification/06-Engine-Server.md) · [spec 03](../specification/03-Protocol.md) |
| **M03** | Transcription pipeline | Player ↔ engine, local-file captioning, sync anchoring + refinement | M01, M02 | [milestone](milestones/03-Transcription-Pipeline.md) · [spec 07 §1](../specification/07-ASR-And-Translation.md) |
| **M04** | Translation pipeline | llama.cpp translator, paragraph chunking, glossary, bilingual tracks | M02, M03 | [milestone](milestones/04-Translation-Pipeline.md) · [spec 07 §2](../specification/07-ASR-And-Translation.md) |
| **M05** | Extension overlay | MV3 extension, tab capture, live captioning on YouTube/any site, styling UI | M02, M03 | [milestone](milestones/05-Extension-Overlay.md) · [spec 09](../specification/09-Browser-Extension.md) · [spec 08](../specification/08-Audio-Capture.md) |
| **M05b** | Open in Sublight Player | One click migrates any page's video into the player (direct → hls/dash → engine relay); resume; captions offline | M03, M05 | [milestone](milestones/05b-Open-in-Player.md) · [spec 04 §9](../specification/04-Player-App.md) · [spec 09 §8](../specification/09-Browser-Extension.md) · [ADR-0017](../architecture/decisions/0017-open-in-player.md) |
| **M06** | Beta 1 | Packaging, token pairing UX, autostart, end-to-end QA, **checkpoint** | M04, M05, M05b* | [milestone](milestones/06-Beta-Release.md) · [checkpoint Beta 1](../checkpoints/Beta-1-Checklist.md) |
| **M07** | Editor & polish | Cue editing, sync nudge UI, prefs UI, perf & UX hardening | M06 | [milestone](milestones/07-Polish-Editing.md) |
| **M08** | Firefox | Port, parity checks, Firefox-specific test matrix | M07 | [milestone](milestones/08-Firefox.md) · [ADR-0015](../architecture/decisions/0015-firefox-port.md) |
| **M09** | Language learning | Dual-language study mode with the sibling tool, vocabulary export | M07/+ | [milestone](milestones/09-Language-Learning.md) |

\* M05b is a **Beta 1 target but non-blocking** — if its engine-relay slice isn't stable by the Beta checkpoint, it carries to Beta 2 without blocking the release.

## Status legend

- `not-started` · `in-progress` · `done` · `blocked` — milestone lifecycle (mirrored in each milestone file's frontmatter).
- **Definition of done** lives per milestone; a milestone isn't done until its acceptance criteria are checked items in a [checkpoint](../checkpoints/README.md).

## How milestones map to the rest of the vault

- Each milestone implements specific [specification](../specification/README.md) sections — the *what/how*.
- Each milestone depends on specific [decisions](../architecture/Decisions.md) — the *why*.
- Each release produces a [checkpoint](../checkpoints/README.md) — the *reality check*.
- Periodic [audits](../audits/README.md) cut across milestones.

## Task conventions

Within each milestone, tasks are written as `M0n.N` (e.g. `M03.4`) and rendered as checkboxes. Acceptance criteria are explicit so "done" is not vibes.

## Current risks (live)

Tracked per milestone; a consolidated view lives in [Roadmap → Risks](Roadmap.md#risks-and-unknowns).