---
tags: [specification, player]
status: specified
updated: 2026-09-23
---

# 04 — Player app

_The React web app: local playback, projects, captioning orchestration, editing, export. Runs at `http://localhost:5173` in dev; packaged as an extension page in prod (no server needed)._

## 1. Responsibilities

- Play local video files (File System Access API handle + drag & drop), with the [overlay](05-Overlay-Rendering.md) rendering active cues.
- **Open a page's video in the player** (from the extension): resolve, play and caption videos migrated from any website (**[§9](#9-opening-a-pages-video-open-in-player-adr-0017)**, [ADR-0017](../architecture/decisions/0017-open-in-player.md)).
- Manage projects: create/open/save in IndexedDB ([02 §5](02-Data-Model.md#5-storage-layout)); import/export `.sublight.json`.
- Orchestrate captioning: stream media to engine ([ADR-0011](../architecture/decisions/0011-local-video-processing.md)), create jobs, subscribe to WS progress, hydrate results into tracks.
- Edit cues (M07) and adjust sync; export SRT; manage glossary & styles.

## 2. Routes & structure

| Route                | Purpose                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `/`                  | Library: recent projects, import, engine status bar                                                  |
| `/open`              | Entry point for a migrated page video (§9): parses payload, creates the project, resolves the source |
| `/player/:projectId` | Playback + overlay + tracks panel                                                                    |
| `/editor/:projectId` | Cue grid + word bar (M07)                                                                            |
| `/settings`          | Styles, defaults, glossary, engine/health/cache                                                      |

Engine-client logic is a framework-light module (`packages/protocol` consumer + WS reconnect + token store) shared conceptually with the extension — see [09 §6](09-Browser-Extension.md#6-messaging-and-state).

## 3. Playback

- `<video>` element with: seek, speed (0.25–2×), fullscreen, picture-in-picture, keyboard map (space, arrows, `[`/`]` nudge).
- Position persisted per project; resumes on open.
- `currentTime` drives the overlay cue scheduler directly (rAF sampling; no setTimeout drift).
- Local files only **except** videos migrated from a page (see [§9](#9-opening-a-pages-video-open-in-player-adr-0017)). The player never lets a user paste an arbitrary remote URL in v1 — remote playback exists _only_ through the open-in-player flow.
- HLS (`.m3u8`) and DASH (`.mpd`) sources are handled with bundled `hls.js` / `dash.js` on the resolution pipeline (§9).

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

- SRT: active track (or all tracks) → download via Blob URL. Named `{project-title}.{lang}.srt`. The track's `syncOffsetMs` nudge is **baked into the exported times** so the file stays in sync in other players.
- `.sublight.json` (M06+): full project export/import.
- Future: SSA/ASS export; per-word HTML export for study notes.

## 8. Engine status integration

- Poll `GET /v1/health` on load + `visibilitychange`; a persistent status bar shows `online/offline`, GPU free VRAM, and running jobs.
- Token: stored in `localStorage` (user-pasted) — the **same token model** as the extension; `sublight://pair` handshake in M06.

## 9. Opening a page's video (open-in-player, [ADR-0017](../architecture/decisions/0017-open-in-player.md))

Part of [M05b](../plan/milestones/05b-Open-in-Player.md). The extension detects the page's video and offers **"Open in Sublight Player"**; clicking it opens a new tab with the Player and the video plays there with every player feature (overlay, styling, captioning, translation, editing, export).

### 9.1 Entry & payload delivery

| Delivery                                   | When                             | Mechanism                                             |
| ------------------------------------------ | -------------------------------- | ----------------------------------------------------- |
| `chrome.storage.session.openInPlayer.last` | packaged player (extension page) | written by the SW, **consumed once** on `/open`       |
| URL hash `#sl=<base64url(json)>`           | dev player (localhost:5173)      | hash keeps the payload out of server logs; cap ~16 KB |

`introspectOpenPayload()` prefers storage, falls back to the hash, and deletes storage on success. No payload → `/open` shows a friendly "nothing to open" card.

```ts
interface OpenInPlayerSource {
  kind: 'https-direct' | 'hls' | 'dash' | 'engine-fetchable' | 'blob-mse' | 'live'
  url: string
  mime?: string
  quality?: string
  canPlayDirectly?: boolean // decided by the extension classifier (09 §8.2)
}

interface OpenInPlayerPayload {
  version: 1
  source: { pageUrl: string; pageTitle?: string }
  media: { title?: string; durationMs?: number; isLive: boolean; sources: OpenInPlayerSource[] }
  resumeAtMs?: number // prefer over ratio when known
  resumeAtRatio?: number
  requestedBy: 'popup' | 'overlay-chip' | 'context-menu'
}
```

### 9.2 Resolution pipeline (first success wins)

1. **S1 — direct URL**: `https-direct` → native `<video>` (no CORS needed to _play_; capture is a separate concern, see 9.4).
2. **S1b — manifests**: `hls`/`dash` → `hls.js` / `dash.js`, feeding the same `<video>`.
3. **S3 — engine resolve & relay**: `engine-fetchable` sources → `POST /v1/media/resolve {url, site}` → engine returns `{ mediaId, durationMs, title }`; the player plays `GET /v1/relay/:id` and shows a **"Preparing media…"** progress while the engine buffers (v1), with `Range`-aware seeking once ready ([06 §4.1](06-Engine-Server.md)).
4. **Failure** → error screen with copy family from [10 §3](../specification/10-Non-Goals-And-Failure-Modes.md) and alternatives: _"Caption this page in place instead"_ (opens the extension's live path) or _"Open the source page"_.

### 9.3 Project wiring

- A project is **created immediately** on `/open` (`media.kind = "page-video"`, `media.pageUrl`, `media.pageTitle`, `media.sources`, effective `media.transport`, `media.directUrl`, `media.relayId` — [02 §1](02-Data-Model.md#1-core-types-typescript-in-packagescore)) so nothing is lost if the tab closes.
- Default project name = source page title; `resumeAtMs` applied on `loadedmetadata` (ignored when `isLive`).
- Re-opening the project from the library re-resolves sources (relay may need re-resolve if the engine restarted) and offers "caption with engine" the same way as local files.

### 9.4 Captioning a migrated video

- **Relayed media** (engine owns the file) → identical to the [local-file pipeline (§4)](04-Player-App.md#4-file-handling-per-adr-0011): T₀ = 0, offline batch, best possible sync.
- **Direct/HLS media**: the player asks the engine to fetch the audio (`mediaHash` path). Cross-origin media without CORS can neither be fetched by the engine nor captured from the player (tainted `captureStream`) — in that case the UI offers the **in-page live caption path** and never fails silently ([08 §7](08-Audio-Capture.md)).

### 9.5 Testing (M05b)

Fixtures: a page with a direct `.mp4`, an HLS page (hls.js fixture), a page with multiple sources, an engine-mock "YouTube" page (relay path), and failure cases (blob-without-yt-dlp, live). Verified on Chromium + Brave.

## 10. Out of scope for the player

- Playing _online_ videos in place (extension territory) — but _migrating_ them into the player **is** in scope (§9).
- Running models (engine) or rendering outside its own page (overlay package handles the rendering it does have).
- Direct pasting of arbitrary remote URLs (v1: only the open-in-player flow). Revisit in a later milestone if users ask.
- Remote sync; multi-user.

## 11. Related

- [Overlay](05-Overlay-Rendering.md) · [Engine](06-Engine-Server.md) · [Protocol](03-Protocol.md) · [Data model](02-Data-Model.md)
- [ADR-0017](../architecture/decisions/0017-open-in-player.md) · [Spec 09 §8](09-Browser-Extension.md#8-open-in-sublight-player) · [Spec 06 §4.1](06-Engine-Server.md#41-media-resolve--relay-open-in-player)
- Milestones: [M01](../plan/milestones/01-Player-Core.md), [M03](../plan/milestones/03-Transcription-Pipeline.md), [M05b](../plan/milestones/05b-Open-in-Player.md), [M07](../plan/milestones/07-Polish-Editing.md)
