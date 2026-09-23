---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M05b — Open in Sublight Player (page-video migration)

**Goal:** a requested, flagship flow — the extension detects the video on *any* page, the user clicks **"Open in Sublight Player"**, a new tab opens, and the video plays there with every player feature: overlay, styling, captioning, translation, editing, export, projects.

Design lives in [ADR-0017](../../architecture/decisions/0017-open-in-player.md) and [Spec 04 §9](../../specification/04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017) / [Spec 09 §8](../../specification/09-Browser-Extension.md#8-open-in-sublight-player).

## Scope

- **Extension side**: classify the page's playing video into transport kinds (direct / hls / dash / engine-fetchable / blob-mse / live); build the `OpenInPlayerPayload` (sources, page URL/title, `resumeAtMs`); deliver by storage handoff (packaged player) or URL hash (dev player).
- **Player side**: `/open` route consumes the payload, creates a page-video project, resolves sources via the layered pipeline (direct → hls.js/dash.js → engine resolve+relay → honest failure), applies resume, plays with the full overlay.
- **Engine side**: `POST /v1/media/resolve` + `GET /v1/relay/:mediaId` (v1 buffers to disk with "Preparing media…" progress; Range-aware seeking) — [Spec 06 §4.1](../../specification/06-Engine-Server.md#41-media-resolve--relay-open-in-player).
- **Captioning a migrated video**: relayed media reuses the local-file pipeline (T₀ = 0, offline batch — the best-sync path); direct/HLS media uses engine best-effort fetch, else the in-page live path with clear copy.
- Popup primary action; overlay chip + video context-menu item are planned follow-ups (M05b.10).

## Tasks

- [ ] **M05b.1** — Source classifier (content script): gather `currentSrc`/`src`/`<source>`/`isLive`/`duration`/`currentTime`; classify per [Spec 09 §8.2](../../specification/09-Browser-Extension.md#82-source-classification-content-script) table; multiple sources ordered by preference.
- [ ] **M05b.2** — Payload builder + handoff: `OpenInPlayerPayload` (schema in [04 §9.1](../../specification/04-Player-App.md#91-entry--payload-delivery)); storage handoff (`chrome.storage.session["openInPlayer.last"]`, consume-once) + dev hash (`#sl=<base64url>`); `tabs.create`.
- [ ] **M05b.3** — Player `/open` route: `introspectOpenPayload()` (storage first, hash fallback), immediate project creation (`media.kind = "page-video"` with pageUrl/title/sources), default name = page title.
- [ ] **M05b.4** — Resolution pipeline S1/S1b: play direct URLs natively; bundle hls.js + dash.js for `.m3u8`/`.mpd`; resume on `loadedmetadata`; feed the shared cue scheduler.
- [ ] **M05b.5** — Resolution pipeline S3: `POST /v1/media/resolve {url, site?}` → play `GET /v1/relay/:id`; "Preparing media…" progress (engine v1 buffering); Range-aware seeking.
- [ ] **M05b.6** — Failure paths: resolve/relay errors map to [copy family](../../specification/10-Non-Goals-And-Failure-Modes.md); alternatives "caption this page in place instead" and "open the source page"; blob-MSE-without-engine-support explained, never silent.
- [ ] **M05b.7** — Captioning a migrated video: relayed → existing local-file transcription orchestration; direct/HLS → engine best-effort audio fetch; teeny gap → in-page live path handoff.
- [ ] **M05b.8** — Project persistence + re-open: transport fields saved ([02 §1](../../specification/02-Data-Model.md#1-core-types-typescript-in-packagescore)); library re-open re-resolves (relay re-resolve after engine restart); resume position persisted.
- [ ] **M05b.9** — Fixtures + e2e (Chromium + Brave): direct `.mp4` page, HLS page, multi-source page, engine-mock "YouTube" (relay path), failure cases (blob-without-yt-dlp, live, DRM-styled).
- [ ] **M05b.10** — Popup UX + planned entry points: primary popup action; overlay chip & video context-menu item scoped as follow-ups.

## Acceptance criteria

1. On a page with a direct `.mp4`: one click → new tab → the video plays in the player with overlay, seeking, styling; captioning works end-to-end (T₀ = 0 path) on Chromium + Brave.
2. On an HLS page: plays via hls.js and captions via engine best-effort fetch (or documented fallback copy).
3. On an engine-mock YouTube page (blob/MSE source): one click → "Preparing media…" → relayed playback with seeking; captions use the offline batch path; sync meets corpus targets.
4. Resume: clicking mid-video resumes at the migrated position.
5. Impossible cases (blob w/o engine support, DRM, live) produce explanations + alternatives — zero silent failures.
6. No new extension permissions; the page is never broken; one overlay per video even when the player tab + page tab coexist.

## Dependencies

- [M03](03-Transcription-Pipeline.md) (player orchestration), [M05](05-Extension-Overlay.md) (discovery, capture, messaging, engine client).
- Engine: `media/resolve` + relay ([M02](02-Local-ASR-Engine.md) engine skeleton is a prerequisite; work lands in M05b).
- ADRs: [0017](../../architecture/decisions/0017-open-in-player.md), plus [0003](../../architecture/decisions/0003-manifest-v3-chromium-first.md) (MV3), [0010](../../architecture/decisions/0010-audio-capture-strategy.md) (capture fallbacks), [0011](../../architecture/decisions/0011-local-video-processing.md) (relay transcription reuses local-file path).

## Open questions

- Whether the engine's v1 buffer-to-disk meeting yt-dlp's format-selection mid-stream is streamable enough for long videos — validate with a 1 h YouTube fixture before committing to the v1 shape (v2 on-the-fly relay is the fallback).
- S2 (service-worker byte relay for referrer-protected direct files) stays out of M05b — only revisit when a real user hits a site the other paths can't cover.

## Related

- [Spec 04 §9](../../specification/04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017) · [Spec 09 §8](../../specification/09-Browser-Extension.md#8-open-in-sublight-player) · [Spec 06 §4.1](../../specification/06-Engine-Server.md#41-media-resolve--relay-open-in-player) · [Spec 02 §1](../../specification/02-Data-Model.md#1-core-types-typescript-in-packagescore) · [Spec 08 §1](../../specification/08-Audio-Capture.md#1-source-hierarchy-per-adr-0010)
- [ADR-0017](../../architecture/decisions/0017-open-in-player.md) · [Data-flow diagram](../../architecture/diagrams/Data-Flow.md)