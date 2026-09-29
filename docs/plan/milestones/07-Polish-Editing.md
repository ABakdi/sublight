---
tags: [plan, milestone]
status: not-started
updated: 2026-09-29
---

# M07 — Editor & polish

**Goal:** turn sublight from "it works" into "it feels owned": a real subtitle editor, fine-grained sync control, preference surface, and performance hardening driven by Beta-1 findings.

## Scope

- **Subtitle editor** (in player + basic in extension popup): seek-to-cue, edit text, split/merge cues, word-level adjust (kicks in word timestamps), delete/insert; undo/redo history.
- **Sync fine-tuning**: per-track nudge, per-cue offset, "shift all after here"; visual waveform/word bar (audio in the player is local so we can draw it — powered by engine-returned word timings, not a wheel).
- Prefs surface: style schema editor (the extension's Options has one since M05.7; the Player's Style panel since M01), default model picks, default target language, glossary management, cache/disk management, engine health & logs view.
- Keyboard shortcuts everywhere relevant; small-screen/fullscreen behavior for the overlay.
- Performance + reliability hardening per [Spec 10](../../specification/10-Non-Goals-And-Failure-Modes.md): memory bounds, long-video chunking, queue UX (nested/interactive), retry semantics.
- Beta-1 checkpoint findings triaged into this milestone (the checkpoint is the backlog source).

## Tasks

- [ ] **M07.1** — Cue editor grid: table/edit/apply; keyboard next/prev; undo/redo stack.
- [ ] **M07.2** — Word-level bar: words as draggable tokens; snapping to neighboring words; save writes back to cue text & times.
- [ ] **M07.3** — Shift-and-split operations ("shift all cues ≥ t by +x ms"), used with live preview.
- [ ] **M07.4** — Prefs app: style editor (live preview pane), defaults, glossary CRUD, cache eviction UI, engine status/logs viewer. _Engine status, cache and model management move into the popup at [M06b.6–8](06b-One-Install.md); what remains here is defaults and glossary CRUD._
- [ ] **M07.5** — Perf pass: long-video memory, overlay render throttling (rAF scheduling), WS backpressure, service-worker wake budget.
- [ ] **M07.6** — Triage Beta-1 checkpoint: every finding either fixed here or routed to a later milestone/ADR with owner.
- [ ] **M07.8** — From the [Beta-1 checkpoint](../../checkpoints/Beta-1-Checklist.md) (B5): translations shift lines around sentence fragments with the count intact. Translate whole sentences and re-split them by timing (or mark continuations), and re-run the English → Arabic / Japanese spot check to ≥ 90 %.
- [ ] **M07.9** — (B6) Translation at 5–7 tok/s when desktop apps take VRAM: offer a smaller variant (e.g. Q3_K_M) that fully fits next to a desktop, and retry full offload when VRAM frees instead of keeping the fallback for the session.
- [ ] **M07.10** — (B7) YouTube sometimes throttles open-ended audio reads to ~1.8× realtime: fetch pieces with bounded byte ranges, as yt-dlp does, and measure the first caption on throttled videos.
- [ ] **M07.11** — (M1, M2) A 2 h corpus clip for the drift bar; measure the Player tab's own memory.
- [ ] **M07.7** — Carried from [M05](05-Extension-Overlay.md): load the overlay lazily instead of bundling React into every frame (content script 268 kB, 85 kB gzipped); start "Better" English (LLM) before the whole transcript is done, and speed up translation in fast feeds, both limited by the whisper ↔ LLM swap on 4 GB.

## Acceptance criteria

1. Edit a mis-timed and mis-typed cue in < 30 s using keyboard only.
2. Undo/redo survives reload (history persisted per project).
3. Fullscreen / small window / zoomed-DPI overlay stays legible and positioned (checked on both browsers).
4. A 2-h video captions and edits without OOM or UI jank (memory measured: player < 1.5 GB, engine stable).
5. Every Beta-1 checkpoint finding has a disposition.

## Dependencies

- [M06](06-Beta-Release.md) and [M06b](06b-One-Install.md) (checkpoint backlog feeds this).
- ADRs: [0014](../../architecture/decisions/0014-storage.md) (history/undo persistence choice), [0008](../../architecture/decisions/0008-word-level-timestamps.md) (word bar).

## Open questions

- Editor in the extension popup: full-featured vs. minimal (lean minimal: the _player_ is the editor; popup handles quick text fix).

## Related

- [Spec 04 — Player App](../../specification/04-Player-App.md) · [Spec 05 — Overlay](../../specification/05-Overlay-Rendering.md)
- [Checkpoints index](../../checkpoints/README.md)
