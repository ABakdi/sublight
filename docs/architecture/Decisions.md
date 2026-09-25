---
tags: [architecture, decisions, index]
status: accepted
updated: 2026-09-23
---

# Decisions — the ADR log

_Every significant decision about sublight lives here. **If changing something would considerably affect the project, it is an ADR.** This is the index; each row links to its full record under [`decisions/`](decisions/)._

## Status legend

| Status       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `proposed`   | Under discussion, not committed.                                      |
| `accepted`   | Committed; specs/milestones that depend on it are consistent with it. |
| `superseded` | Replaced by a newer ADR (link included).                              |
| `deprecated` | No longer true; keep the record for history.                          |

## The decision log

| #                                                        | Decision (short title)                         | Date       | Status     | Summary                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](decisions/0001-monorepo-layout.md)                | Monorepo, pnpm workspaces                      | 2026-09-23 | `accepted` | One repo: `apps/` (player, extension, engine) + `packages/` (core, overlay, protocol).                                                                                           |
| [0002](decisions/0002-frontend-stack.md)                 | Frontend stack                                 | 2026-09-23 | `accepted` | React 19 + TS 5 + Vite + Tailwind 4 + Zustand; WXT for the extension.                                                                                                            |
| [0003](decisions/0003-manifest-v3-chromium-first.md)     | MV3, Chromium-first                            | 2026-09-23 | `accepted` | Ship Chromium/Brave first; Firefox later via WXT cross-browser abstraction.                                                                                                      |
| [0004](decisions/0004-local-engine-outside-extension.md) | AI runs in a local companion engine            | 2026-09-23 | `accepted` | Web pages/extension never run models; engine owns GPU + models + queue.                                                                                                          |
| [0005](decisions/0005-engine-stack.md)                   | Engine stack                                   | 2026-09-23 | `accepted` | Node 22 + TS + Hono; subprocesses: whisper.cpp, llama.cpp, ffmpeg.                                                                                                               |
| [0006](decisions/0006-engine-transport.md)               | Engine transport                               | 2026-09-23 | `accepted` | HTTP + WebSocket on `127.0.0.1`, bearer token; native messaging deferred.                                                                                                        |
| [0007](decisions/0007-whisper-model-matrix.md)           | Whisper model matrix                           | 2026-09-23 | `accepted` | Default `small`; `base` fast; `distil-large-v3-turbo` best; offload for bigger.                                                                                                  |
| [0008](decisions/0008-word-level-timestamps.md)          | Word-level sync pipeline                       | 2026-09-23 | `accepted` | Word timestamps + capture-offset anchoring + refinement pass = "perfect" sync.                                                                                                   |
| [0009](decisions/0009-translation-stack.md)              | Translation stack                              | 2026-09-23 | `accepted` | Local LLM over paragraph chunks, not per-cue. Amended: 0018 (Whisper for →English), 0019 (model: Qwen3-4B, Apache-2.0).                                                          |
| [0010](decisions/0010-audio-capture-strategy.md)         | Audio capture strategy                         | 2026-09-23 | `accepted` | `captureStream` where allowed → tab capture default for online → upload for local; yt-dlp optional.                                                                              |
| [0011](decisions/0011-local-video-processing.md)         | Local file processing                          | 2026-09-23 | `accepted` | Player streams file to engine; engine extracts/normalizes audio (no ffmpeg.wasm).                                                                                                |
| [0012](decisions/0012-overlay-shadow-dom.md)             | Overlay architecture                           | 2026-09-23 | `accepted` | Shadow DOM + shared React overlay package; CSS-variable style schema.                                                                                                            |
| [0013](decisions/0013-engine-api.md)                     | Engine API v1                                  | 2026-09-23 | `accepted` | REST jobs + WS events; versioned from day one; JSON protocol.                                                                                                                    |
| [0014](decisions/0014-storage.md)                        | Storage strategy                               | 2026-09-23 | `accepted` | IndexedDB (player projects), chrome.storage (prefs), engine JSONL jobs + content-hash cache.                                                                                     |
| [0015](decisions/0015-firefox-port.md)                   | Firefox port plan                              | 2026-09-23 | `proposed` | WXT + `browser.*` polyfill; all_frames; tabCapture parity check; no MV2.                                                                                                         |
| [0016](decisions/0016-model-licensing.md)                | Model licensing & supply chain                 | 2026-09-23 | `accepted` | Pinned HF repos + revisions + SHA-256; license allowlist; NLLB is non-commercial.                                                                                                |
| [0017](decisions/0017-open-in-player.md)                 | Open in Sublight Player (page-video migration) | 2026-09-23 | `accepted` | One click moves a page's video into the Player: classified sources (direct / hls / dash / engine-fetchable / blob), layered transport, storage+hash handoff, no new permissions. |
| [0018](decisions/0018-whisper-translate-to-english.md)   | Whisper translate for →English; LLM optional   | 2026-09-25 | `accepted` | Whisper's built-in `translate` task makes English subtitles from any language with no extra model; the LLM is installed on demand for other targets.                             |
| [0019](decisions/0019-translator-qwen3-4b.md)            | Translator model: Qwen3-4B-Instruct-2507       | 2026-09-25 | `accepted` | Apache-2.0 successor to Qwen2.5-3B (research license); Q4_K_M in llama.cpp b11174; NLLB off the default path (non-commercial).                                                   |

## The process for changing a decision

1. **Decide it matters** — will this ripple through specs, milestones, or the user experience? If yes → ADR.
2. **Write the ADR** as `proposed` (copy [0001](decisions/0001-monorepo-layout.md) as a template), add it to this index.
3. **Update dependents** — link the ADR from the specs and milestones it touches.
4. **Accept** once committed; keep statuses honest as reality diverges (`superseded` + new ADR, never rewrite history).

## What is _not_ an ADR

- Small implementation choices (a component name, a function signature) → the Specification.
- Task sequencing → the Plan.
- Findings after a release → Checkpoints.
- Checklist improvements → Audits.
