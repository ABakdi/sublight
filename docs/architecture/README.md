---
tags: [architecture, index]
status: accepted
updated: 2026-09-23
---

# Architecture

_Home of the system's architecture: the shape of the system, the decisions that shape it, the requirements that constrain it, and the diagrams that make it visible._

> This folder records **decisions we took and decisions we will take** — technology choices, software requirements, and anything that, if changed, would impact the project considerably. If a change is big enough to ripple through the rest of the docs, it is **an ADR first**.

---

## The architecture at a glance

```
                    ┌──────────────────────────────────────────────┐
                    │              USER'S MACHINE                  │
                    │  (32 GB RAM · Quadro T1000 4 GB · i7 9th gen)│
                    └───────▲──────────────────────────▲───────────┘
                            │                          │
              localhost HTTP/WS (token)                │ localhost HTTP/WS (token)
┌───────────────────────────┴───────┐   ┌──────────────┴────────────────────┐
│   SUBLIGHT EXTENSION (MV3)        │   │   SUBLIGHT PLAYER (React app)     │
│   Chromium / Brave (later FF)     │   │   local video files · projects    │
│   · content script + overlay      │   │   · subtitle editor · export SRT  │
│   · tab audio capture             │   │   · ffmpeg-free (engine does it)  │
└───────────────────────────────────┘   └───────────────────────────────────┘
                            │                          │
                            └───────────┬──────────────┘
                                        ▼
                    ┌──────────────────────────────────────────────┐
                    │           SUBLIGHT ENGINE (Node 22)          │ 127.0.0.1:17421
                    │  job queue · model manager · auth · caching  │
                    ├──────────────────────────┬───────────────────┤
                    │ whisper.cpp (ASR 16 kHz) │ llama.cpp (LLM)   │ subprocesses
                    │ word-level timestamps    │ translation       │
                    │ ffmpeg (audio normalize) │                   │
                    └──────────────────────────┴───────────────────┘
                                   ▲ models (local, open source)
                                   │   ~/.sublight/models
```

Three cooperating parts, one machine, zero cloud. See the [component diagram](diagrams/Components.md) and [deployment diagram](diagrams/Deployment.md) for more detail, and the [system spec](../specification/01-System-Overview.md) for the full component contracts.

---

## Key architecture principles

1. **AI never runs inside the extension or the page.** Browsers can't hold 4 GB models, service workers die, and pages shouldn't see raw audio. All inference is done by the local engine.
2. **The engine is a process, not a library.** It owns the models, the queue, and the GPU. Clients (extension + player) talk to it over `127.0.0.1` with a bearer token.
3. **One package of shared truth.** Subtitle data model, protocol types, overlay component — shared between player and extension so behavior can't drift.
4. **Local-first, offline-first.** Everything must work with no internet (after model download). The network is only ever optional sugar.
5. **Audio capture is an abstraction.** Same-origin element capture, tab capture, and file upload all feed one "captured audio" pipeline, so adding a new source later is a plug-in, not a rewrite.
6. **Sync is a first-class pipeline, not an afterthought.** Word-level timestamps + capture-offset anchoring + a second refinement pass = subtitles that land on the words.
7. **Everything significant is an ADR.** If it changes the project considerably, it is recorded in [Decisions](Decisions.md) before code touches it.

---

## Contents of this area

| Doc                                | What it covers                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Requirements](Requirements.md)    | Hardware/software requirements, model constraints, non-functional targets (accuracy, latency, privacy). |
| [Decisions](Decisions.md)          | **The ADR index** — every significant decision, current status, and a process for changing one.         |
| [Diagrams](diagrams/Components.md) | Component diagram with responsibilities.                                                                |
| [Diagrams](diagrams/Data-Flow.md)  | Sequence diagrams: live captioning, offline refinement, local-file captioning, translation.             |
| [Diagrams](diagrams/Deployment.md) | Runtime topology: processes, ports, subprocesses, data paths.                                           |

## Related areas

- [Specification](../specification/README.md) — component-level detail of what the architecture decides.
- [Plan](../plan/README.md) — the milestones that build this architecture in order.
- [Checkpoints](../checkpoints/README.md) — realities that contradict this architecture get found _there_, then fixed _here_.
- [Audits](../audits/README.md) — security/quality audits of the implementation of this architecture.

---

## How a decision changes

1. Write a new [ADR](Decisions.md) (copy the pattern from existing ones), status `proposed`.
2. Update the [Decisions index](Decisions.md); link the affected specs and milestones.
3. Mark `accepted` once committed to; update the specs that depend on it.
4. If it turns out wrong: mark `superseded`/`deprecated` and **write the follow-up ADR** — never edit history.
