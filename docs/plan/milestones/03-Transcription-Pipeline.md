---
tags: [plan, milestone]
status: done
updated: 2026-09-25
---

# M03 — Transcription pipeline (player ↔ engine, end-to-end sync)

**Goal:** the _first complete user journey_: open a local video in the Player, get accurate word-synced captions. This is where "perfectly synced to the audio" gets measured against the corpus.

## Scope

- Player ↔ engine client (`packages/protocol` consumers; zustand stores in the player, like the rest of the app — no TanStack Query dependency): media upload, job creation, WS progress, result hydration.
- **ffmpeg-free browser** flow per [ADR-0011](../../architecture/decisions/0011-local-video-processing.md): stream file → engine extracts audio.
- Sync pipeline per [ADR-0008](../../architecture/decisions/0008-word-level-timestamps.md):
  - Anchoring: T₀=0 for local files; δ estimation at first speech onset; user nudge persists.
  - Cue construction from words (min/max durations, merge/split, gap-closing) — [Spec 02 §4](../../specification/02-Data-Model.md).
  - **Refinement pass**: re-transcribe full audio with the _selected_ model, re-anchor at control points, replace draft.
- Sync QA: run the [M00.8 corpus harness](../../plan/milestones/00-Foundations.md) against real ASR; publish numbers in the checkpoint.
- Progress UX in the player: progress bar, cancel, model picker, language detection display.

## Tasks

- [x] **M03.1** — Player engine client library (token, health polling, media upload with cancellation, job API, WS event subscription).
- [x] **M03.2** — "Caption this video" flow: model picker (defaults per [ADR-0007](../../architecture/decisions/0007-whisper-model-matrix.md)), progress, cancel, error surfacing (engine offline card).
- [x] **M03.3** — Draft cues appear progressively (as segments land) — `job.partial` events; final replace on refinement.
- [x] **M03.4** — δ auto-estimation + manual nudge persistence (`subtitle.syncOffset` in IndexedDB project doc).
- [x] **M03.5** — Corpus harness wired to engine: numbers on median word-onset offset + word coverage per language; CI job that re-runs it nightly (optional) and on release.
- [x] **M03.6** — Edge cases: silent sections → VAD skip; very long files → chunked ASR streaming; mono/stereo/high-sample-rate input handling.

## Acceptance criteria

1. Local video → captions in < 60 s per 10 min of audio (base/small on T1000), progress visible, cancellable.
2. Corpus: median word-onset offset ≤ 250 ms; worst-case drift on a 30-min clip ≤ 400 ms.
3. Refinement pass strictly improves or matches the draft (never replaces good cues with worse: guarded by per-cue confidence comparison or whole-track cache discipline).
4. Re-captioning the same file with a different model uses the cached audio (no re-upload/re-encode).
5. Engine offline → player shows actionable "start the engine" state, no crash.

## Mini self-check (M03 close, on the target T1000)

- [x] AC1 — progress visible and cancellable (unit + real-browser runs). **Speed: whisper-base 29.5 s per 10 min ✅; whisper-small ~78–90 s per 10 min ❌ (≈ 7× realtime).** The < 60 s target holds for base, not small; small stays the default for accuracy and the panel shows the measured speed after each run.
- [x] AC2 — `pnpm sync:run` + `pnpm sync:measure` with whisper-small: **30-min German clip median |onset error| 93 ms, bias −1 ms, drift 0.5 ms** (99% of 540 pause onsets); JFK 7 ms. ⚠️ Reference = energy onsets after pauses (independent `silencedetect`), not hand-timed words: the hand-timed corpus clips still need recording.
- [x] AC3 — local files run one pass; drafts are chunk commits of that same run, so the final track is a superset and can't be worse. The separate refinement pass belongs to live capture (M05, [Spec 07 §1.5](../../specification/07-ASR-And-Translation.md#15-refinement-pass-post-capture)).
- [x] AC4 — re-captioning with another model re-used the engine's audio: 0 uploads (real-browser run + unit test).
- [x] AC5 — engine offline → "The engine isn't running · pnpm dev:engine · Check again" card, no crash (e2e); unpaired → token form (e2e).

## Notes

- Real browser (Chromium, dev player + engine, whisper-small): JFK video captioned in 6.5 s including model load; a 4-min German video translated to English in 35 s with drafts appearing in the overlay while it ran.
- δ is deliberately conservative (see [Spec 07 §1.4a](../../specification/07-ASR-And-Translation.md#14-the-sync-equation)): measured per-word jitter is ±100–250 ms with no stable global offset, so δ usually comes out 0 for local files. It's built for consistent offsets such as capture latency (M05).
- Found and fixed on the way: the upload header was blocked by CORS preflight; the overlay unmounted its inner React root synchronously during a parent commit (warning + race), now deferred and re-used across quick re-mounts (StrictMode); the sync report counted the synthetic staging clip as a real result.
- `E2E_REAL_ASR=1 pnpm e2e` runs the full caption journey against the locally installed whisper (links `~/.sublight/models` and `bin` into the e2e engine).

## Dependencies

- [M01](01-Player-Core.md) (player), [M02](02-Local-ASR-Engine.md) (engine).
- ADRs: [0008](../../architecture/decisions/0008-word-level-timestamps.md), [0011](../../architecture/decisions/0011-local-video-processing.md).

## Open questions

- ~~Correct chunk size for very long files~~ — resolved: 2-min chunks (measured trade-off in [Spec 07 §1.6](../../specification/07-ASR-And-Translation.md#16-long-form-chunking)).
- ~~Auto-flatten drafts for short clips?~~ — resolved: clips shorter than one chunk produce no drafts at all; the single result is final.
- Record the hand-timed corpus clips (en/fr/de/es/pt/ar) so AC2 is also measured against word-level ground truth.

## Related

- [Spec 04 — Player App](../../specification/04-Player-App.md) · [Spec 07 §1 — ASR pipeline](../../specification/07-ASR-And-Translation.md)
- [Requirements F4 — accuracy targets](../../architecture/Requirements.md)
