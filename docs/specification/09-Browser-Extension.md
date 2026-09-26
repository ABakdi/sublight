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
permissions: ["storage", "tabCapture", "activeTab", "scripting", "offscreen", "downloads"]
page shortcuts (content script, with captions on): Alt+Shift+V / , / . / 0 / T / K
commands: toggle-captions (Alt+Shift+C), toggle-live (Alt+Shift+L)
host_permissions: ["http://127.0.0.1:17421/*", "http://localhost:17421/*"]
content_scripts: [ { matches ["<all_urls>"], js [content], all_frames: true, run_at: "document_idle" } ]
action: { default_popup: "popup.html" }
```

- **Stable dev ID:** the manifest pins a public `key` (`apps/extension/wxt.config.ts`), so every unpacked install is `ehgdbfcecgkljnpmednociabmmjemfkf` (`DEV_EXTENSION_ID` in `packages/protocol`) and the engine allowlists `chrome-extension://<that id>` by default ([Protocol §3](03-Protocol.md#3-auth--hardening)). Store builds drop the key and their ID goes into the engine's `allowedOrigins` config.
- No `tabs` permission: the popup targets the active tab via `activeTab`, and other tabs' URLs stay hidden.
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

Iframe players: each frame discovers its own video; the frame with a playing, visible video (> 40% viewport) wins the overlay; others stand down. When the mainframe video is _also_ playing (e.g. yt ads overlay) the ad instance is ignored (duration < 60 s heuristic + not-user-interacted).

YouTube specifics (spec'd, then verified in [checkpoints](../checkpoints/README.md)):

- Hide the host captions when our track is active (click the CC state via the player API if present, else overlay covers it).
- Use `video` element events (`timeupdate`, `play`, `pause`, `seeking`, `ended`) — resilient to YouTube DOM churn; never internal class names.
- SPA video switch: on `yt-navigate-finish`-equivalent signals we re-detect; old overlay host removed atomically.

### 4.4 What's implemented (pre-M05 slice)

Built so the extension can be installed and tested in a real browser before capture exists (`pnpm ext:try`, [CONTRIBUTING](../../CONTRIBUTING.md#trying-the-extension-in-a-real-browser)):

- **Discovery:** each frame scans `<video>` on media events (`play`, `pause`, `loadedmetadata`, `seeked`, `ratechange`, `ended`, `emptied`), on DOM mutations and on URL changes (2 s check for SPA navigation). The primary video is the one that is playing and visible, else the largest visible one. Frames report `video.state` only when something changed. There's no per-second timer: the popup extrapolates the playhead from `reportedAt` × `playbackRate`, so a playing tab doesn't keep the SW awake.
- **SW:** keeps per-tab, per-frame state in `storage.session`, cleared on tab close and full navigation; answers `tab.status`, `engine.status` and `demo.toggle`.
- **Test captions:** `demo.set` mounts the shared overlay over the primary video with synthetic cues (every 2.5 s, stamped with their start time). A fixed-position frame on `<html>` tracks the video's box every animation frame, so the page layout is never touched, and moves into `document.fullscreenElement` in fullscreen. It stands down when a sublight overlay already exists on the page (e.g. the Player).
- **Pairing:** the Options page stores the token in `storage.local`. `engine.status` distinguishes `no-token`, `unauthorized`, `refused` (Host/Origin), `offline` and `online`.
- Verified in Brave 153 (direct MP4, YouTube including SPA navigation and fullscreen) and headless Chromium (`pnpm e2e:extension`).

Known gaps, for M05: the caption can sit on top of the host player's control bar while it's visible (YouTube); the content script bundles React + overlay (~235 kB) into every frame and should load the overlay lazily.

### 4.5 Live captions (as built, M05)

- **Start**: popup "Caption live" or **Alt+Shift+L** (`commands.toggle-live`) → SW `startLive`: creates the engine `live` job (model/language from Options, default whisper-small / auto), opens the engine WS subscribed to it, and sends `live.begin` to the frame that owns the primary video.
- **Page** (`src/liveContent.ts`): sends anchors on playback events, taps the element audio (`captureStream`) when possible, asks for `live.fallback` when it stays silent, and renders `live.track` updates in an `OverlayFrame` (drafts delayed by the measured lag, final exact).
- **Offscreen document** (`entrypoints/offscreen`): tabCapture path, audio played back to the user.
- **SW** (`src/liveController.ts`): relays `live.audio` / `live.anchor` to the engine, forwards `job.partial` drafts and the final result to the page, keeps `LiveState` in `storage.session` for the popup (starting → listening → refining → done / error).
- **Popup**: "Caption live" / "Stop live captions" with one status line: source ("this video's audio" / "the tab's audio"), cue count, lag; refining; done; or the error in words (e.g. "The speech model isn't installed…", "Extension has not been invoked for the current page…").
- Captions sit above player control bars: the overlay margin is 14 % of the video height (min 32 px). The popup's size (S/M/L) and position (bottom/top) toggles live in `storage.local.overlayStyle` and apply to every overlay at once.
- **Navigation**: a URL change or the video's `emptied` event (new source) ends the session: captions removed, job stopped, result kept for **Download SRT** only (`storage.session.liveTrack:<tabId>` = `{ track, final }`: every draft is stored as it arrives, so the popup can save the draft so far while listening, and the refined track replaces it after Stop; cleared when a new session starts).
- **Notices**: muted video; tab audio silent for 8 s while playing (muted tab or DRM). **Player page**: refused, since the Player captions its own video.
- **Options**: live model, spoken language, and "Subtitles in" (spoken language / English via Whisper `translate`).
- Found in the build: with `monitor` constant-folded to `false` in the content script, Rollup emitted a `for` loop with no body (`for (…) if (opts.monitor) t.stop()`), which broke the bundle; the loop is braced now.

### 4.6 Captions ahead of playback (as built, ADR-0020)

- **SW** (`captionsController.ts`): "Caption this video" creates a `url` job with the owning frame's URL, the `<video>`'s http(s) src (`VideoState.primary.src`), the browser's User-Agent, the captions model (Options, default whisper-small) and `fromMs` = the playhead. It follows the job over the engine WS, sends each track to the frame (`captions.track`), stores it (`storage.session.captionsTrack:<tabId>`) and relays seeks to `/v1/url/:id/focus`. After a SW restart, `captions.status` re-attaches to the running job.
- **Content** (`captionsContent.ts`): `PageCaptions` shows the track at exact media time (no delay), holds playback where captions aren't ready ("Captioning this part…"), and hides during ads (element duration ≠ `mediaDurationMs`). A URL change to another video (compared without `t`/`si`/… parameters) ends it; YouTube rewriting `&t=` does not.
- **Download SRT** (`captions.download`, mode `words` | `sentences`): saves right away when the whole video is done, else waits for the running job (the popup shows its progress), else starts one. Saved with `chrome.downloads` as `<page title>.<lang>[.word-by-word].srt`. A pending download keeps running if the tab navigates away.
- **Display modes** (`cuesForMode`, core): **word by word** (text grows as each word is spoken) or **sentences** (one sentence per cue, ≤ 2 lines and 7 s, long ones split at a clause break near the middle). The same modes shape the overlay and the SRT.

### 4.7 Quick controls on the video (ADR-0021)

- `QuickControls` (`src/quickControls.tsx`) renders in its own shadow root inside the overlay frame (`[data-sublight-controls]`); key, pointer, click and wheel events stop there.
- Collapsed: a 34 px **CC** button (dim until the pointer is over the video). Open: **Captions** On/Off, **Translate to** (Original, English, Arabic, French, Spanish, German, Italian, Portuguese, Dutch, Russian, Turkish, Hindi, Japanese, Korean, Chinese), **Delay** (− / typed ms / +, 100 ms steps, ±30 s, Reset), and a note line ("Translating to French… 40 %", "No speech found in this video", "Live: about 3 s behind").
- Drag the button or the panel's handle; release snaps to the nearest corner (`nearestCorner`). The corner and open state are in `storage.local.quickControls`. Bottom corners sit above the player's control bar (60 % of the caption margin); on vertical videos top corners drop below the feed's top buttons.
- `ViewerControls` (`src/viewerControls.ts`) holds the viewer's on/off and delay for the page's lifetime (so a feed scroll keeps them) and the "Translate to" preference (`storage.local.captionTarget`, last language in `lastTranslateTarget`). Live captions get the same controls without translation.
- **Show both** (with a translation; Alt+Shift+B; `storage.local.showBoth`): the original is the main line (word by word) and the translation sits above it, smaller. Whisper translates in its own chunks, so originals and translations that overlap are grouped (`pairWithOriginal`, core) and a group's translation stays up exactly while its originals do: the lines change together and never leave a gap. English comes with its original from the same `url` job (`bilingual: true`); other languages pair the LLM translation with the transcript it came from.
- The delay is added to the overlay's offset (`OverlayFrame.setUserDelay`): + shows captions later. A toast confirms each change ("Delay +300 ms", "Captions off").

### 4.8 Short-form feeds (ADR-0021)

- **Follow:** after "Caption this video" the page keeps captions on until they are stopped (`following`). When another video starts playing (checked on `play` and every 2 s), the content script sends `captions.next` with that video's state and the SW starts a new `url` job for it (quiet restart: the page keeps its controls). A pending "Download SRT" of the previous video is finished first.
- **The video's own URL** (`videoPageUrl`): on TikTok, Instagram and Facebook feeds, the nearest link to a single video (`/@user/video/<id>`, `/reel/<id>`, `/p/<id>`), searching upward from the `<video>` but not past a container holding other videos. It goes to the engine as `pageUrl`.
- **Vertical video** (width < 0.8 × height): text scales by the shorter side ([05](05-Overlay-Rendering.md)), lines wrap at 24 characters (`cuesForMode(…, { maxLineChars: 24 })`), captions sit 22 % up.

### 4.9 Updates and a stale service worker

After the extension's files change on disk (a new build of the unpacked extension), Chromium and Brave keep running the **old service worker** until the extension is reloaded, while the popup loads the new files. New popup actions then reach an old background that doesn't know them and nothing happens (seen 2026-09-26: "Caption this video" and "Download SRT" silently did nothing). Each build has one id (`__SUBLIGHT_BUILD__`, `src/build.ts`) in every entrypoint. The popup pings the SW and compares ids; on a mismatch it shows **"Reload sublight"** (`runtime.reload()`), and any action the background doesn't answer says so instead of doing nothing. Content scripts in tabs opened before a reload are orphaned, so reload the page too.

### 4.10 Closed tabs and leases

A tab's jobs end with it. Closing the tab (`tabs.onRemoved`), or reloading or leaving the page (the content script's `pagehide` → `page.gone`), cancels its captioning, its translation and its live job (no refinement). In-page URL changes don't count; following a feed handles those. A requested download still finishes. The engine backs this up: the extension starts `url` and `translate` jobs with `lease: true` and renews them every 30 s (`/v1/jobs/:id/keepalive`), so if the browser itself goes away they are cancelled after 90 s. (Seen 2026-09-26: a French translation of a closed tab's video held the GPU for 15 minutes and survived engine restarts; every new captions job queued behind it.) Measured in Brave: tab closed → job cancelled in 4.9 s; page reloaded → 7.3 s.

## 5. Capture wiring

The content script drives [Audio capture](08-Audio-Capture.md): probe `captureStream()`, fall back to `tabCapture` (audio-only) requested from the SW; chunks streamed via the SW's WS channel to the engine with `{ mediaTimeStart = T₀ }`.

## 6. Messaging and state

```
content script ◄─runtime.sendMessage─► SW ◄─fetch/WS─► engine
      ▲                                      │
      └────────── popup (port, bi-directional)┘
```

| Message                          | Direction                     | Payload                                                         |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `video.state`                    | content→SW                    | as §4.3                                                         |
| `capture.start` / `capture.stop` | SW→content (after user click) | —                                                               |
| `track.ready`                    | SW→content                    | `SubtitleTrack` (+ `draft` flag)                                |
| `track.partial`                  | SW→content                    | draft cues                                                      |
| `style.changed`                  | SW→content (from options)     | `SubtitleStyle`                                                 |
| `job.progress`                   | SW→popup                      | percentage + phase                                              |
| `tab.status` / `engine.status`   | popup→SW                      | per-frame `VideoState[]` / `EngineStatus` (implemented)         |
| `demo.toggle` → `demo.set`       | popup→SW→content              | test captions on/off (implemented)                              |
| `openInPlayer.request`           | popup→SW                      | builds & delivers the payload (§8); returns `{ ok, playerUrl }` |
| `openInPlayer.probe`             | SW→content                    | asks the owning frame for source classification data (§8.2)     |

## 7. Popup & options

- **Popup (as built, 2026-09-26):** engine badge in the header; a video card (page title, playing/paused, time, site); **"Caption this video"** with a timeline of captioned parts and the playhead, status ("Captioned up to 9:30 · 38 % of the video") and "Pause until captions are ready"; **Display** (word by word / sentences, size S/M/L, position); **Download subtitles** (word by word / sentences + Download SRT, with progress while the rest is transcribed); **More** (live captions for live streams and unreachable videos, test captions). Planned: language picker, "Open in Sublight Player" (§8).
- **Options**: full [style schema](02-Data-Model.md#6-style-schema) editor with live preview; default model/language; glossary; engine health (port, token status, "Open logs"); pairing flow (paste token / `sublight://`); cache/disk controls; per-site overrides (e.g. disable on a site).

## 8. Open in Sublight Player

Per [ADR-0017](../architecture/decisions/0017-open-in-player.md): detects the page's video and lets the user run it in the full Player. Spec'd on the player side in [04 §9](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017); this section is the extension's half.

### 8.1 Entry points

1. **Popup action** (primary, M05b): shown whenever a video is detected; copy: _"Open in Sublight Player"_.
2. **Contextual overlay chip** (planned): a small, unobtrusive button pinned near the video's top-right corner (respects the show-on-hover conventions of [05 §8](05-Overlay-Rendering.md#8-interactions); opt-in/off per site).
3. **Video context-menu item** (planned): on "Inspector"-free right-click on the video.

### 8.2 Source classification (content script)

For the playing `<video>`, gather: `currentSrc`, `src`, all `<source>` children, `isLive`, `duration`, `currentTime`, `videoWidth/Height`. Then classify each candidate URL:

| Rule                                                                             | Kind               |
| -------------------------------------------------------------------------------- | ------------------ |
| starts with `blob:` **and** site on the engine resolve list (yt-dlp: YouTube, …) | `engine-fetchable` |
| starts with `blob:` (otherwise)                                                  | `blob-mse`         |
| ends `.m3u8` / is HLS                                                            | `hls`              |
| ends `.mpd` / is DASH                                                            | `dash`             |
| otherwise a fetchable `https:`/`http:` media URL                                 | `https-direct`     |
| `video.isLive === true`                                                          | also sets `isLive` |

The best candidate wins for `canPlayDirectly` (a `https-direct`/`hls`/`dash` source). Multiple sources are kept in the payload ordered by preference.

### 8.3 Payload delivery

1. Popup clicks "Open in Sublight Player" → SW builds the `OpenInPlayerPayload` (§ schema in [04 §9.1](04-Player-App.md#91-entry--payload-delivery)) with `resumeAtMs = video.currentTime`.
2. **Packaged** player (extension page): SW writes `chrome.storage.session["openInPlayer.last"]` then `tabs.create({url: PLAYER_URL + "#open"})`. Player consumes-and-deletes on `/open` ([04 §9.1](04-Player-App.md#91-entry--payload-delivery)).
3. **Dev** player: SW opens `DEV_PLAYER_URL + "#sl=" + base64url(json)` (cap ~16 KB; larger payloads keep only top sources).
4. `tabs.create` needs **no new permissions**; classification needs none either (data from the content script's own frame).

### 8.4 What we deliberately do _not_ do

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
