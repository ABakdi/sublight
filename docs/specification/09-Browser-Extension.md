---
tags: [specification, extension]
status: specified
updated: 2026-09-23
---

# 09 — Browser extension

_The MV3 extension (WXT): how sublight reaches any website's video, captures its audio, overlays captions, bridges to the engine — and hands the video over to the Player._

## 1. Structure (WXT)

```
apps/extension/
├─ wxt.config.ts
├─ entrypoints/
│  ├─ background.ts        # service worker
│  ├─ content.ts           # all_frames injector
│  ├─ popup/               # popup UI (React)
│  └─ options/             # options/settings page (React; also hosts pairing)
└─ src/                    # commands, site-detectors, capture, engine client
```

Outputs: Chromium MV3 (dev + built), later Firefox via WXT target ([ADR-0015](../architecture/decisions/0015-firefox-port.md)).

## 2. Manifest (relevant keys)

```
permissions: ["storage", "tabCapture", "activeTab", "scripting"]
host_permissions: ["http://127.0.0.1:17421/*", "http://localhost:17421/*"]
content_scripts: [ { matches ["<all_urls>"], js [content], all_frames: true, run_at: "document_idle" } ]
action: { default_popup: "popup.html" }
```

- `tabCapture` power justifies the permission prompt; copy explains why (only while the user clicks "Caption").
- No `<all_urls>` host permission beyond the engine; page scripts run in isolated worlds.

## 3. Service worker (background)

- Wakes on: `runtime.onMessage` (from content), `action.onClicked`, engine WS reconnect timer (alarms, min period 30 s), `tabs.onUpdated` (for SPA state hints).
- State kept in `chrome.storage.session` (job ids per tab, engine status, active requests); nothing heavy, survives SW restarts.
- **Engine calls happen only here** (content scripts can't fetch localhost with our auth+origin model reliably, and pages shouldn't see the token): a small `engineFetch` wrapper with token from `chrome.storage.local`, auto-retry on `ECONNREFUSED` (engine cold start), and WS reconnect with backoff.
- Authorization is the **token + Host/Origin checks** from [Protocol §3](03-Protocol.md#3-auth--hardening); content scripts never hold the token.

## 4. Content script (all frames)

Per frame:
1. Watch for `<video>` elements (`MutationObserver` + periodic + SPA hooks on `history.pushState`/`replaceState`/`popstate`).
2. The **primary frame** owning a playing video gets the overlay host ([05 §1](05-Overlay-Rendering.md)); a `data-sublight-host` marker prevents duplicates across frames.
3. Report video state to the SW: `{ tabId, frameId, hasVideo, isPlaying, currentTime, paused, duration }`.

Iframe players: each frame discovers its own video; the frame with a playing, visible video (> 40% viewport) wins the overlay; others stand down. When the mainframe video is *also* playing (e.g. yt ads overlay) the ad instance is ignored (duration < 60 s heuristic + not-user-interacted).

YouTube specifics (spec'd, then verified in [checkpoints](../checkpoints/README.md)):
- Hide the host captions when our track is active (click the CC state via the player API if present, else overlay covers it).
- Use `video` element events (`timeupdate`, `play`, `pause`, `seeking`, `ended`) — resilient to YouTube DOM churn; never internal class names.
- SPA video switch: on `yt-navigate-finish`-equivalent signals we re-detect; old overlay host removed atomically.

## 5. Capture wiring

The content script drives [Audio capture](08-Audio-Capture.md): probe `captureStream()`, fall back to `tabCapture` (audio-only) requested from the SW; chunks streamed via the SW's WS channel to the engine with `{ mediaTimeStart = T₀ }`.

## 6. Messaging and state

```
content script ◄─runtime.sendMessage─► SW ◄─fetch/WS─► engine
      ▲                                      │
      └────────── popup (port, bi-directional)┘
```

| Message | Direction | Payload |
|---|---|---|
| `video.state` | content→SW | as §4.3 |
| `capture.start` / `capture.stop` | SW→content (after user click) | — |
| `track.ready` | SW→content | `SubtitleTrack` (+ `draft` flag) |
| `track.partial` | SW→content | draft cues |
| `style.changed` | SW→content (from options) | `SubtitleStyle` |
| `job.progress` | SW→popup | percentage + phase |
| `openInPlayer.request` | popup→SW | builds & delivers the payload (§8); returns `{ ok, playerUrl }` |
| `openInPlayer.probe` | SW→content | asks the owning frame for source classification data (§8.2) |

## 7. Popup & options

- **Popup**: current page video status; "Caption this video" (start/stop); live progress; language picker (target(s)); quick style toggles (size/position/theme); "Built with" draft state ruler; **"Open in Sublight Player" primary action** when a video is detected (§8).
- **Options**: full [style schema](02-Data-Model.md#6-style-schema) editor with live preview; default model/language; glossary; engine health (port, token status, "Open logs"); pairing flow (paste token / `sublight://`); cache/disk controls; per-site overrides (e.g. disable on a site).

## 8. Open in Sublight Player

Per [ADR-0017](../architecture/decisions/0017-open-in-player.md): detects the page's video and lets the user run it in the full Player. Spec'd on the player side in [04 §9](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017); this section is the extension's half.

### 8.1 Entry points

1. **Popup action** (primary, M05b): shown whenever a video is detected; copy: *"Open in Sublight Player"*.
2. **Contextual overlay chip** (planned): a small, unobtrusive button pinned near the video's top-right corner (respects the show-on-hover conventions of [05 §8](05-Overlay-Rendering.md#8-interactions); opt-in/off per site).
3. **Video context-menu item** (planned): on "Inspector"-free right-click on the video.

### 8.2 Source classification (content script)

For the playing `<video>`, gather: `currentSrc`, `src`, all `<source>` children, `isLive`, `duration`, `currentTime`, `videoWidth/Height`. Then classify each candidate URL:

| Rule | Kind |
|---|---|
| starts with `blob:` **and** site on the engine resolve list (yt-dlp: YouTube, …) | `engine-fetchable` |
| starts with `blob:` (otherwise) | `blob-mse` |
| ends `.m3u8` / is HLS | `hls` |
| ends `.mpd` / is DASH | `dash` |
| otherwise a fetchable `https:`/`http:` media URL | `https-direct` |
| `video.isLive === true` | also sets `isLive` |

The best candidate wins for `canPlayDirectly` (a `https-direct`/`hls`/`dash` source). Multiple sources are kept in the payload ordered by preference.

### 8.3 Payload delivery

1. Popup clicks "Open in Sublight Player" → SW builds the `OpenInPlayerPayload` (§ schema in [04 §9.1](04-Player-App.md#91-entry--payload-delivery)) with `resumeAtMs = video.currentTime`.
2. **Packaged** player (extension page): SW writes `chrome.storage.session["openInPlayer.last"]` then `tabs.create({url: PLAYER_URL + "#open"})`. Player consumes-and-deletes on `/open` ([04 §9.1](04-Player-App.md#91-entry--payload-delivery)).
3. **Dev** player: SW opens `DEV_PLAYER_URL + "#sl=" + base64url(json)` (cap ~16 KB; larger payloads keep only top sources).
4. `tabs.create` needs **no new permissions**; classification needs none either (data from the content script's own frame).

### 8.4 What we deliberately do *not* do

- No new host permissions (`<all_urls>` stays out) — engine relay covers the sites we support; S2 SW-relay (v2) is scoped in [ADR-0017](../architecture/decisions/0017-open-in-player.md) when/if it becomes necessary.
- No DRM migration (N1): EME videos are clamped to "caption in place", per [10 §2](10-Non-Goals-And-Failure-Modes.md).

## 9. Permissions & privacy notes

- `tabCapture` audio is used **only** while a user-initiated capture job is running; stream life ends with the job; nothing is stored in the browser; the engine keeps the normalized audio cache ([02 §5](02-Data-Model.md#5-storage-layout)) which is deletable.
- Content script executes on `document_idle`, all frames — necessary for iframe players; site-disabling via Options respects user control.
- No analytics, no beaconing, no remote anything (network use = model download + optional yt-dlp).

## 10. Testing matrix (shared with checkpoints)

`YouTube · Vimeo · generic `<video>` page · iframe player page · SPA (YouTube) · page with multiple videos · PiP/fullscreen · **open-in-player migration (direct / HLS / relay / failure)**` × `Chromium · Brave` (+ Firefox at M08). See [Beta-1 checklist](../checkpoints/Beta-1-Checklist.md).

## 11. Related

- [Overlay](05-Overlay-Rendering.md) · [Capture](08-Audio-Capture.md) · [Protocol](03-Protocol.md) · [Player §9 — open-in-player](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017)
- ADRs [0002](../architecture/decisions/0002-frontend-stack.md) · [0003](../architecture/decisions/0003-manifest-v3-chromium-first.md) · [0010](../architecture/decisions/0010-audio-capture-strategy.md) · [0012](../architecture/decisions/0012-overlay-shadow-dom.md) · [0015](../architecture/decisions/0015-firefox-port.md) · [0017](../architecture/decisions/0017-open-in-player.md)
- Milestone [M05b](../plan/milestones/05b-Open-in-Player.md)