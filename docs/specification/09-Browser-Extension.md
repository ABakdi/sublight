---
tags: [specification, extension]
status: specified
updated: 2026-09-23
---

# 09 — Browser extension

_The MV3 extension (WXT): how sublight reaches any website's video, captures its audio, overlays captions, and bridges to the engine._

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

## 7. Popup & options

- **Popup**: current page video status; "Caption this video" (start/stop); live progress; language picker (target(s)); quick style toggles (size/position/theme); "Built with" draft state ruler.
- **Options**: full [style schema](02-Data-Model.md#6-style-schema) editor with live preview; default model/language; glossary; engine health (port, token status, "Open logs"); pairing flow (paste token / `sublight://`); cache/disk controls; per-site overrides (e.g. disable on a site).

## 8. Permissions & privacy notes

- `tabCapture` audio is used **only** while a user-initiated capture job is running; stream life ends with the job; nothing is stored in the browser; the engine keeps the normalized audio cache ([02 §5](02-Data-Model.md#5-storage-layout)) which is deletable.
- Content script executes on `document_idle`, all frames — necessary for iframe players; site-disabling via Options respects user control.
- No analytics, no beaconing, no remote anything (network use = model download + optional yt-dlp).

## 9. Testing matrix (shared with checkpoints)

`YouTube · Vimeo · generic `<video>` page · iframe player page · SPA (YouTube) · page with multiple videos · PiP/fullscreen` × `Chromium · Brave` (+ Firefox at M08). See [Beta-1 checklist](../checkpoints/Beta-1-Checklist.md).

## 10. Related

- [Overlay](05-Overlay-Rendering.md) · [Capture](08-Audio-Capture.md) · [Protocol](03-Protocol.md)
- ADRs [0002](../architecture/decisions/0002-frontend-stack.md) · [0003](../architecture/decisions/0003-manifest-v3-chromium-first.md) · [0010](../architecture/decisions/0010-audio-capture-strategy.md) · [0012](../architecture/decisions/0012-overlay-shadow-dom.md) · [0015](../architecture/decisions/0015-firefox-port.md)