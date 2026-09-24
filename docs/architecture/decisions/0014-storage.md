---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0014 — Storage strategy

**Status:** accepted

## Context

State exists in four different lifetimes: (1) **user preferences** (subtitle style, language) — small, sync-worthy; (2) **player projects** (video refs, tracks, cue edits, settings per project) — medium, offline, must survive restarts; (3) **engine state** (installed models, jobs, media cache, token) — machine-level; (4) **transient** (service-worker state, in-flight progress).

## Decision

| Lifetime             | Store                                                                                                                             | Notes                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preferences          | `chrome.storage.sync` (extension) · localStorage mirror/unify via shared prefs module (player)                                    | Small key/values only; style schema from [Spec 05](../../specification/05-Overlay-Rendering.md).                                                                        |
| Player projects      | **IndexedDB** (single DB `sublight-projects`, stores: `projects`, `tracks` (keyed by project+track, blob-friendly), `media` refs) | Offline, fast, survives restarts; project = JSON doc that can also be exported/imported as a `.sublight.json` file.                                                     |
| Engine machine-state | `~/.sublight/` — `config.json` (token, settings), `models/`, `media-cache/`, `jobs.jsonl` (append-only job log)                   | Jobs are **resumable**: completed chunks + idempotency keys persist; a crash loses only in-flight worker progress ([Spec 06](../../specification/06-Engine-Server.md)). |
| Transient            | `chrome.storage.session` / memory                                                                                                 | Service-worker wake-up state; never durable.                                                                                                                            |

**No remote sync in v1** (privacy-first); a manual project export/import is the escape hatch, and the language-learning milestone (M09) may add a local-portable library file (`.sublight.json` bundle).

## Consequences

**Good:** each store matches its data's lifetime exactly; browser storage holds no model weights or audio; crash-resilience lives where it's cheap (engine log).
**Cost:** three storage _backends_ to learn once, tested separately; IndexedDB migrations must be planned (schema version + migration functions from day one); engine cache eviction policy needed (disk budget).

## Alternatives considered

- **Everything in IndexedDB** (including prefs) — chrome.storage.sync already syncs across devices for free; prefs are small; rejected as overkill.
- **SQLite in the engine for everything** — engine would hold browser-facing state; browser can't reach it offline when the engine is down; rejected.
- **Electron/local storage in the player** — no desktop app in scope; rejected.

## Links

- [Spec 02 §6 — storage](../../specification/02-Data-Model.md)
- [Spec 06 §5 — engine state & cache](../../specification/06-Engine-Server.md)
- [ADR-0006](0006-engine-transport.md)
