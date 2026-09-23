---
tags: [specification, player]
status: specified
updated: 2026-09-23
---

# 04 — Player app

_The React web app: local playback, projects, captioning orchestration, editing, export. Runs at `http://localhost:5173` in dev; packaged as an extension page in prod (no server needed)._

## 1. Responsibilities

- Play local video files (File System Access API handle + drag & drop), with the [overlay](05-Overlay-Rendering.md) rendering active cues.
- Manage projects: create/open/save in IndexedDB ([02 §5](02-Data-Model.md#5-storage-layout)); import/export `.sublight.json`.
- Orchestrate captioning: stream media to engine ([ADR-0011](../architecture/decisions/0011-local-video-processing.md)), create jobs, subscribe to WS progress, hydrate results into tracks.
- Edit cues (M07) and adjust sync; export SRT; manage glossary & styles.

## 2. Routes & structure

| Route | Purpose |
|---|---|
| `/` | Library: recent projects, import, engine status bar |
| `/player/:projectId` | Playback + overlay + tracks panel |
| `/editor/:projectId` | Cue grid + word bar (M07) |
| `/settings` | Styles, defaults, glossary, engine/health/cache |

Engine-client logic is a framework-light module (`packages/protocol` consumer + WS reconnect + token store) shared conceptually with the extension — see [09 §6](09-Browser-Extension.md#6-messaging-and-state).

## 3. Playback

- `<video>` element with: seek, speed (0.25–2×), fullscreen, picture-in-picture, keyboard map (space, arrows, `[`/`]` nudge).
- Position persisted per project; resumes on open.
- `currentTime` drives the overlay cue scheduler directly (rAF sampling; no setTimeout drift).
- Local files only (no remote playback URLs in v1 — page videos are the extension's job).

## 4. File handling (per [ADR-0011](../architecture/decisions/0011-local-video-processing.md))

1. `showOpenFilePicker` (FSA) or drag & drop → `File` object; keep a `FileSystemFileHandle` for re-open.
2. On "Caption this video": player **streams the file** to `PUT /v1/media/:id` (fetch with `duplex: 'half'`, cancellable via job cancel). Engine stores normalized audio by hash.
3. On success, `media.mediaHash` is saved to the project → **re-captioning is instant** (cache) and re-`transcribe` with another model reuses audio.

## 5. Captioning flow (UI states)

1. **Idle** → user sets language/model (defaults from settings) → **Uploading** (progress on bytes) → **Transcribing** (draft cues stream in via `job.partial`, overlay shows them live) → **Refining** (progress %; overlay still shows drafts) → **Done** (final cues replace drafts atomically, `draft:false`) → optional **Translate** (target language; progress; new track appears).
2. Cancellation at any pre-done state: engine cancels job; partial drafts can be kept (`Keep drafts`) or discarded.
3. Errors: engine offline → dedicated card with "Start engine" + pairing shortcut; `AUDIO_EMPTY` → explain silence/DRM; unsupported container → engine ffmpeg already handles most — surfaced if it fails.

## 6. Editor (M07)

- Grid: rows = cues; columns start/end/text/lang; click to seek; inline edit; split (at caret's word boundary) / merge; insert/delete.
- Word bar: words rendered as tokens with editable tick positions; drag to micro-adjust; snap to neighbors; handles δ and per-cue offset.
- Command palette for shift-all-after-t operations (`shift cues ≥ T by +Δ`).
- Undo/redo: snapshot-based, persisted to IndexedDB (`project.undoStack`, cap 200 entries).

## 7. Export

- SRT: active track (or all tracks) → download via Blob URL. Named `{project-title}.{lang}.srt`.
- `.sublight.json` (M06+): full project export/import.
- Future: SSA/ASS export; per-word HTML export for study notes.

## 8. Engine status integration

- Poll `GET /v1/health` on load + `visibilitychange`; a persistent status bar shows `online/offline`, GPU free VRAM, and running jobs.
- Token: stored in `localStorage` (user-pasted) — the **same token model** as the extension; `sublight://pair` handshake in M06.

## 9. Out of scope for the player

- Playing *online* videos (extension territory).
- Running models (engine) or rendering outside its own page (overlay package handles the rendering it does have).
- Remote sync; multi-user.

## 10. Related

- [Overlay](05-Overlay-Rendering.md) · [Engine](06-Engine-Server.md) · [Protocol](03-Protocol.md) · [Data model](02-Data-Model.md)
- Milestones: [M01](../plan/milestones/01-Player-Core.md), [M03](../plan/milestones/03-Transcription-Pipeline.md), [M07](../plan/milestones/07-Polish-Editing.md)