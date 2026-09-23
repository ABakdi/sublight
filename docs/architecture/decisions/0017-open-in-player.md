---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0017 — "Open in Sublight Player": migrating a page's video into the player

**Status:** accepted

## Context

A requested feature: *the add-on detects the video on the page, and the user can choose to "Open in Sublight Player" — a new tab opens and the video plays there with all the Player features* (overlay, styling, transcription, translation, editing, export).

The UI is easy. The hard part is **media transport** — getting a video that lives inside an arbitrary page to play in a different context:

- `video.currentSrc` can be a **direct file** (`https://…/movie.mp4`), an **HLS manifest** (`.m3u8`), a **DASH manifest** (`.mpd`), or — very commonly on YouTube-like players — a **`blob:` URL backed by MediaSource (MSE)**, which is *not a fetchable URL at all*.
- **Playing** a cross-origin URL needs no CORS (the `<video>` tag doesn't care). But **capturing the audio** (captureStream / WebAudio) and **fetching with the page's cookies/referrer** do — those constraints decide which transports are possible.
- The Player already has the best-sync pipeline for media it can *own* (local-file path, T₀ = 0, offline batch — [ADR-0008](0008-word-level-timestamps.md)). If migration can land the media on the engine, transcription is free reuse of that path.

## Decision

A layered design; each layer is honest about what it can't do.

### 1. Detection & payload (extension)
The extension classifies the playing video's sources into kinds and builds an `OpenInPlayerPayload` (schema in [Spec 04 §9](../../specification/04-Player-App.md) / [Spec 09 §8](../../specification/09-Browser-Extension.md)):

| Source kind | Detected when | Migratable? |
|---|---|---|
| `https-direct` | `currentSrc`/`<source>` is a direct media file (mp4/webm/ogg/mp3…) | ✅ play directly |
| `hls` / `dash` | `.m3u8` / `.mpd` manifests | ✅ via hls.js / dash.js |
| `engine-fetchable` | `blob:` (MSE) **and** the site is on the engine's resolve list (yt-dlp: YouTube, Vimeo…) | ✅ via engine relay |
| `blob-mse` | `blob:` without engine support | ❌ explained, not silent |
| `live` | `video.isLive` | ⚠️ playback may work; transcription deferred (N7) |

### 2. Handoff (extension → Player)
- Build payload: sources (ordered), `pageUrl`, `pageTitle`, `durationMs`, `resumeAtMs`/`resumeAtRatio`, `isLive`, `requestedBy`.
- Deliver by **storage handoff** when the Player is the packaged extension page (write `chrome.storage.session.openInPlayer.last`, consume-once), and by **URL hash** (`#sl=<base64url(json)>`) for the dev player (localhost). Hash cap ~16 KB; beyond it use a storage/tab-state fallback (dev) or truncate source list.
- **No new permissions**: `chrome.tabs.create` needs none; the content script already knows the page URL and title.

### 3. Resolution in the Player (layered, first-wins)
1. **S1 — direct URL playback**: `https` media file → native `<video>`.
2. **S1b — manifest playback**: hls.js / dash.js for HLS & DASH sources (bundled in the player app).
3. **S3 — engine resolve + relay**: for `engine-fetchable` sites, `POST /v1/media/resolve {url, site}` (engine uses its fetch rules / yt-dlp) → engine returns a `relayId`; Player plays `GET /v1/relay/:id` (Range-aware). v1 buffers to disk with a "Preparing media…" progress; v2 streams with on-the-fly Range relay.
4. **S2 — service-worker byte relay (planned, v2)**: for referrer/cookie-protected *direct* files, the MV3 service worker fetches with the page's cookies + set `Referer` (via `declarativeNetRequest`), and streams bytes to the player through a `web_accessible_resources` fetch handler. Deferred — it is the most complex and rare case.
5. **Failure** → explicit screen: "this video can't be moved" with alternatives (caption in place via the extension's live path; open the source page).

### 4. Transcription of a migrated video
- **Relayed media** → exactly the [local-file pipeline (ADR-0011)](0011-local-video-processing.md) (T₀ = 0): best-possible sync, offline batch. 
- **Direct/manifest media** → engine best-effort fetch of the audio (CORS permitting); if the site blocks it and the media is cross-origin (so the player's own captureStream is tainted), the UI offers "caption it in the page instead" (live path) — never a silent gap.

## Consequences

**Good:** one click upgrades a page's video into the full Player experience; YouTube (via relay) gets *offline, word-perfect* captioning instead of live-draft; S1/S1b cover most non-DRM sites with zero engine involvement; no new permissions; honest error copy where transport is impossible.
**Cost:** engine `resolve`/`relay` endpoints add disk + streaming complexity ([Spec 06 §4.1](../../specification/06-Engine-Server.md)); yt-dlp carries ToS/breakage caveats already tracked in [ADR-0010](0010-audio-capture-strategy.md); MSE/blob sources outside the relay list can't migrate (documented, not silent); S2 is genuinely hard and deferred.

## Alternatives considered

- **Only copy the URL** (player pastes it manually) — works for S1 sites but abandons metadata/resume/detection UX; rejected as the primary path (offered as a fallback affordance).
- **Always in-page live captioning** — great but doesn't give the user the *player* (editing, styling, export, projects) they explicitly asked for.
- **Native messaging / filesystem handoff** — overkill for moving a URL+metadata; rejected per [ADR-0006](0006-engine-transport.md).

## Links

- [Spec 04 §9 — opening a page's video](../../specification/04-Player-App.md) · [Spec 09 §8 — extension side](../../specification/09-Browser-Extension.md) · [Spec 02 §1 — media data](../../specification/02-Data-Model.md) · [Spec 06 §4.1 — resolve & relay](../../specification/06-Engine-Server.md) · [Spec 03 §2 — endpoints](../../specification/03-Protocol.md)
- Milestone [M05b](../../plan/milestones/05b-Open-in-Player.md)