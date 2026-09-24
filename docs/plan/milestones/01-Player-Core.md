---
tags: [plan, milestone]
status: done
updated: 2026-09-24
---

# M01 — Player core

**Goal:** the Sublight Player plays local videos and renders styled, synced subtitles — with import/export — before any AI exists. This makes the player testable with hand-made SRT files and proves the overlay before it has to serve live captions.

## Scope

- Playback: local files via File System Access API + drag & drop; controls, seek, speed, fullscreen, shortcuts.
- `packages/overlay` first real use: Shadow-DOM cue renderer with the full styling schema ([Spec 05](../../specification/05-Overlay-Rendering.md)).
- `packages/core` round-trip: SRT parse/write, VTT stub, cue validation (min duration, no overlap — [Spec 02](../../specification/02-Data-Model.md)).
- Projects: create, open, save to IndexedDB; a track = language + cues + style; per-project style overrides.
- Manual sync nudge (offset ±50 ms) to validate the UX before automation exists.
- Export SRT; import SRT; import VTT (best effort).

## Tasks

- [x] **M01.1** — `core`: `SubtitleCue`, `SubtitleTrack`, `SubtitleProject`, `parseSRT`, `writeSRT`, `parseVTT`, validation + gap/merge rules; Vitest coverage.
- [x] **M01.2** — `overlay`: Shadow DOM host, cue scheduling (current-cue by `video.currentTime`), CSS-variable style schema, position anchors, resize observer; unit + visual tests.
- [x] **M01.3** — Player app shell: video element, transport controls, file open (FSA + dnd), playback position persistence (IndexedDB).
- [x] **M01.4** — Projects UI: tracks panel, language picker (metadata only — no translation yet), style picker bound to overlay schema, import/export buttons.
- [x] **M01.5** — Sync nudge: +/-50 ms whole-track offset controls with live preview.
- [x] **M01.6** — e2e: load fixture video + SRT in Playwright (Chromium + Brave), assert cues render at expected times, offset shifts them.

## Acceptance criteria

1. Play a 5-min local `.mp4` with a hand-written SRT: cues appear within ±50 ms at the right times, no flicker or overlap.
2. Styles change live (color, bg, size, font, position) and persist per project across reloads.
3. SRT → overlay → SRT round-trip is byte-stable for a defined fixture set (ignoring EOLs).
4. Import of a malformed SRT never crashes the app; errors reported in the UI.
5. Playwright e2e green on Chromium and Brave.

## Mini self-check (M01 close)

- [x] AC1 — e2e seeks to mid-cue and asserts the overlay shows the cue (no overlap: gap region renders empty); rAF scheduling, no timers.
- [x] AC2 — e2e changes color + anchor live on the overlay; style + tracks persist in IndexedDB across a page reload.
- [x] AC3 — e2e exports and compares export text byte-for-byte against `e2e/fixtures/captions.en.srt`.
- [x] AC4 — store test imports a malformed file: `{ added: 0, errors: [...] }`, no crash, UI shows the error banner.
- [x] AC5 — `pnpm e2e` green on Chromium (7/7); Brave run per ADR-0003 when a Brave binary is present (`findBravePath`).

## Notes

- VTT import shipped as best effort (`parseVtt`) + `detectSubtitleFormat` for import-buttons; VTT export stays M07.
- Player chrome keeps the dark zinc theme (open question resolved: keep for Beta 1).
- FSA `showOpenFilePicker` stores the `FileSystemFileHandle` in IDB settings for project re-open; drag & drop / input falls back gracefully with a re-attach prompt.
- Manual nudge applies `track.syncOffsetMs` (`shiftCues`, clamped ≥ 0 ms per cue); `[` / `]` keys mirror the ±50 ms buttons.

## Dependencies

- [M00 Foundations](00-Foundations.md) (scaffold, harness).
- ADRs: [0001](../../architecture/decisions/0001-monorepo-layout.md), [0002](../../architecture/decisions/0002-frontend-stack.md), [0012](../../architecture/decisions/0012-overlay-shadow-dom.md), [0014](../../architecture/decisions/0014-storage.md).

## Open questions

- ~~Default color scheme/theme for the player chrome~~ — resolved: dark zinc, keep for Beta 1.
- ~~Whether VTT import matters for Beta 1 (defer if low value)~~ — resolved: shipped as best-effort import; export deferred to M07.

## Related

- [Spec 04 — Player App](../../specification/04-Player-App.md) · [Spec 05 — Overlay Rendering](../../specification/05-Overlay-Rendering.md) · [Spec 02 — Data Model](../../specification/02-Data-Model.md)
- [Checkpoint template](../../checkpoints/Template.md) — first checkpoint target is Beta 1, but M01 gets a mini self-check against its own criteria.
