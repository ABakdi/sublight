---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M03 — Transcription pipeline (player ↔ engine, end-to-end sync)

**Goal:** the _first complete user journey_: open a local video in the Player, get accurate word-synced captions. This is where "perfectly synced to the audio" gets measured against the corpus.

## Scope

- Player ↔ engine client (`packages/protocol` consumers; TanStack Query hooks in the player): media upload, job creation, WS progress, result hydration.
- **ffmpeg-free browser** flow per [ADR-0011](../../architecture/decisions/0011-local-video-processing.md): stream file → engine extracts audio.
- Sync pipeline per [ADR-0008](../../architecture/decisions/0008-word-level-timestamps.md):
  - Anchoring: T₀=0 for local files; δ estimation at first speech onset; user nudge persists.
  - Cue construction from words (min/max durations, merge/split, gap-closing) — [Spec 02 §4](../../specification/02-Data-Model.md).
  - **Refinement pass**: re-transcribe full audio with the _selected_ model, re-anchor at control points, replace draft.
- Sync QA: run the [M00.8 corpus harness](../../plan/milestones/00-Foundations.md) against real ASR; publish numbers in the checkpoint.
- Progress UX in the player: progress bar, cancel, model picker, language detection display.

## Tasks

- [ ] **M03.1** — Player engine client library (token, health polling, media upload with cancellation, job API, WS event subscription).
- [ ] **M03.2** — "Caption this video" flow: model picker (defaults per [ADR-0007](../../architecture/decisions/0007-whisper-model-matrix.md)), progress, cancel, error surfacing (engine offline card).
- [ ] **M03.3** — Draft cues appear progressively (as segments land) — `job.partial` events; final replace on refinement.
- [ ] **M03.4** — δ auto-estimation + manual nudge persistence (`subtitle.syncOffset` in IndexedDB project doc).
- [ ] **M03.5** — Corpus harness wired to engine: numbers on median word-onset offset + word coverage per language; CI job that re-runs it nightly (optional) and on release.
- [ ] **M03.6** — Edge cases: silent sections → VAD skip; very long files → chunked ASR streaming; mono/stereo/high-sample-rate input handling.

## Acceptance criteria

1. Local video → captions in < 60 s per 10 min of audio (base/small on T1000), progress visible, cancellable.
2. Corpus: median word-onset offset ≤ 250 ms; worst-case drift on a 30-min clip ≤ 400 ms.
3. Refinement pass strictly improves or matches the draft (never replaces good cues with worse: guarded by per-cue confidence comparison or whole-track cache discipline).
4. Re-captioning the same file with a different model uses the cached audio (no re-upload/re-encode).
5. Engine offline → player shows actionable "start the engine" state, no crash.

## Dependencies

- [M01](01-Player-Core.md) (player), [M02](02-Local-ASR-Engine.md) (engine).
- ADRs: [0008](../../architecture/decisions/0008-word-level-timestamps.md), [0011](../../architecture/decisions/0011-local-video-processing.md).

## Open questions

- Correct chunk size for very long files (memory vs. speed); resolved during M03.6.
- Should draft cues be auto-flattened to final (no refinement) for short clips < 3 min? (Lean yes; sets expectations that draft is already good on short audio.)

## Related

- [Spec 04 — Player App](../../specification/04-Player-App.md) · [Spec 07 §1 — ASR pipeline](../../specification/07-ASR-And-Translation.md)
- [Requirements F4 — accuracy targets](../../architecture/Requirements.md)
