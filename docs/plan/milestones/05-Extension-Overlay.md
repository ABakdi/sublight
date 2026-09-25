---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M05 — Extension overlay (any site, live captioning)

**Goal:** the signature moment — open YouTube (or any site), click "Caption this", and watch subtitles appear a few seconds behind the audio, in your language, styled to your liking.

## Scope

- MV3 extension ([ADR-0003](../../architecture/decisions/0003-manifest-v3-chromium-first.md), [ADR-0002](../../architecture/decisions/0002-frontend-stack.md)), WXT build for Chromium + Brave.
- Content scripts: `all_frames: true`; video discovery (`document.querySelector('video')` + MutationObserver + SPA navigation hooks); single overlay host per playing video.
- Overlay mount via `packages/overlay` in a Shadow DOM host ([ADR-0012](../../architecture/decisions/0012-overlay-shadow-dom.md)).
- **Audio capture** per [ADR-0010](../../architecture/decisions/0010-audio-capture-strategy.md): same-origin `captureStream` → `tabCapture` fallback (audio-only) → live streaming to engine with `{mediaTimeStart = T₀}` anchor.
- Live captioning path: rolling ~30 s windows through ASR while playing ([Spec 07 §1.3](../../specification/07-ASR-And-Translation.md)); VAD gating for pauses.
- After capture: refinement pass + translation job; overlay swaps draft for final.
- Popup: current video state, language picker, capture start/stop, style quick-toggles; Options page: full style schema, token pairing, model defaults, yt-dlp toggle (M05.8).
- YouTube specifics: hide native captions; interact with the yt player surface without breaking it; survive SPA navigation between videos.

## Tasks

- [ ] **M05.1** — WXT scaffold from M00 becomes the real extension: manifest permissions (storage, tabCapture, host_permissions for engine origin, `activeTab`), background service worker bridge to engine (token from storage; WS reconnect).
- [ ] **M05.2** — Content script: video discovery + sizing observer + SPA hooks; overlay host append; `all_frames` and cross-frame coordination via `chrome.runtime.sendMessage`.
- [ ] **M05.3** — Overlay integration (shared component) with live cue scheduler; pause/seek handling.
- [ ] **M05.4** — Capture: same-origin captureStream; tabCapture fallback with permission flow UX; stream chunks + anchor to engine; capture lifecycle tied to page visibility.
- [ ] **M05.5** — Live captioning loop (rolling window) with draft cues; progress in popup.
- [ ] **M05.6** — Post-capture refinement + translation wiring; track stored in `chrome.storage.session` (transient) + optional save to project (player import).
- [ ] **M05.7** — Popup + options UIs (style controls bound to overlay schema; language picker; pairing; model picker).
- [ ] **M05.8** — yt-dlp toggle (power feature): engine-side fetch + transcribe without watching.
- [ ] **M05.9** — Site matrix harness: YouTube, Vimeo, embedded iframe players, generic `<video>` pages — automated smoke + manual checklist ([checkpoint contacts](../../checkpoints/Beta-1-Checklist.md)).

## Progress (pulled forward, 2026-09-25)

So the extension can be installed and tested in a real browser before the engine can caption ([Spec 09 §4.4](../../specification/09-Browser-Extension.md#44-whats-implemented-pre-m05-slice)):

- M05.1 (partial): stable dev ID + engine origin allowlist; SW state in `storage.session`; engine status probe. WS bridge still to do.
- M05.2 (partial): video discovery, primary-video choice, SPA URL watch, per-frame reporting.
- M05.3 (partial): overlay mounted over page videos (fixed frame tracking the video box, fullscreen-aware) with synthetic test cues.
- M05.7 (partial): popup (engine, tab video, test captions) and Options (token pairing).
- `pnpm ext:try` launcher; `pnpm e2e:extension` covers ID, pairing, discovery and overlay placement.

Found in real Brave 153, to handle in this milestone: captions overlap the YouTube control bar while it shows; the content script bundle (~235 kB) should lazy-load the overlay; unpacked installs need Developer mode on (the launcher seeds it).

## Acceptance criteria

1. On YouTube: click → permission → captions appear live ≤ 8 s behind speech; survive seek/pause/new-video navigation; no visual breakage of the page (no layout shift, host plays normally).
2. Same flow works on Vimeo and a generic `<video>` page; embedded-iframe video captions work.
3. Styling changes from popup apply instantly and persist across sessions.
4. DRM/blocked captures show a clear explanation, not silence (no silent failure).
5. All 4 flows from [Data-flow diagram 1](../../architecture/diagrams/Data-Flow.md) render captions on the video, not the page.
6. The extension runs concurrently with the player without double-captioning (only one overlay per video).

## Dependencies

- [M02](02-Local-ASR-Engine.md), [M04](04-Translation-Pipeline.md) (engine jobs).
- ADRs: [0003](../../architecture/decisions/0003-manifest-v3-chromium-first.md), [0010](../../architecture/decisions/0010-audio-capture-strategy.md), [0012](../../architecture/decisions/0012-overlay-shadow-dom.md).

## Open questions

- YouTube fullscreen behavior (video container resize, `document.fullscreenElement`) — resolved in M05.2/M05.9 with a dedicated fixture.
- Whether live drafts should appear with a "draft" tint so users know refinement is coming (nice; do it).

## Related

- [Spec 08 — Audio Capture](../../specification/08-Audio-Capture.md) · [Spec 09 — Browser Extension](../../specification/09-Browser-Extension.md) · [Spec 05 — Overlay](../../specification/05-Overlay-Rendering.md)
