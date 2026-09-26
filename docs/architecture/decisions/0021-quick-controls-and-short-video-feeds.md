---
tags: [architecture, decision]
status: accepted
date: 2026-09-26
---

# ADR-0021: Quick controls on the video, and short-form video feeds

**Status:** accepted. Builds on [ADR-0020](0020-caption-ahead-of-playback.md) (captions made ahead of playback).

## Context

Two needs came out of real use:

1. **Control without the popup.** While watching, the viewer wants to turn captions off, pick a translation, or nudge the timing by a fraction of a second. Opening the toolbar popup every time interrupts the video, and does nothing in fullscreen.
2. **Short-form feeds** (TikTok, Instagram Reels, YouTube Shorts). The videos are vertical (9:16), short (10–90 s), and replaced by the next one on every scroll, often under a URL that names the feed, not the video. Captions sized for a 16:9 player were too large and too wide there, and a caption session ended at the first scroll.

## Decision

- **Quick controls in the video** (`apps/extension/src/quickControls.tsx`):
  - A small **CC** button in a corner of the video opens a panel with captions **on/off**, **Translate to** and **Delay**. Delay moves in ±100 ms steps or takes a typed number (+ is later, − is earlier, up to ±30 s).
  - It renders in its own shadow root inside the overlay frame, so page CSS can't restyle it and its key and pointer events never reach the site. Typing "5" in the delay box must not seek YouTube to 50 %.
  - It can be dragged anywhere and **snaps to the nearest corner**. The corner and the open/closed state are remembered for all sites (`storage.local.quickControls`). It dims when the pointer leaves the video.
- **Keyboard shortcuts** on a page with captions (physical keys, any layout):
  - Alt+Shift+V: on/off.
  - Alt+Shift+, and Alt+Shift+.: delay ∓100 ms. Alt+Shift+0: no delay.
  - Alt+Shift+T: original ↔ the last translation language.
  - Alt+Shift+K: open/close the controls.
  - Browser-level commands: Alt+Shift+C (captions) and Alt+Shift+L (live).
  - All modifier chords, so they don't collide with site keys (YouTube's C, K, J, L, arrows).
- **Translate to:**
  - **English** runs Whisper on the audio (`url` job with `task: "translate"`), still ahead of playback with segment timing ([ADR-0018](0018-whisper-translate-to-english.md)).
  - **Other languages** translate the finished transcript with the LLM (`translate` job, [ADR-0019](0019-translator-qwen3-4b.md)), which keeps the transcript's timing. The transcript shows until the translation is ready. Missing model → a note pointing to Options, which can install it.
  - The choice is a saved preference, applied to every next video, and "Download SRT" saves the language shown.
- **Show both** (for language learners): with a translation on, the original is the main line (word by word) and the translation sits above it. English comes from the same `url` job run as `bilingual` (each piece translated, then transcribed; the English first, so it isn't delayed), timed to the original's words; overlapping originals and translations are grouped so both lines change together.
- **Short-form feeds:**
  - **Captions follow the viewer:** they stay on for the page until stopped. When another video starts playing (a feed scroll, the next video, SPA navigation), it is captioned too; the previous job and any translation still running for it are cancelled.
  - **This video's own page:** on TikTok, Instagram and Facebook feeds the content script walks up from the `<video>` to the nearest link to a single video, stopping before a container holding other videos. YouTube Shorts updates the URL itself.
  - **Vertical layout:** caption text scales by the video's **shorter side** (its width on a 9:16 video) instead of its height; lines wrap at 24 characters instead of 42; captions sit 22 % up from the bottom, above the feed's own caption and buttons; the controls keep clear of the top and bottom bars.
- **Sites that need a login** (Instagram, private or age-restricted videos): an **opt-in** Options setting, "Use my browser login", lets the local engine's yt-dlp read that browser's cookies (`cookiesFromBrowser` on the `url` job). It is off by default. Without it, yt-dlp's "login required" errors say where to turn it on.
- **Can't be fetched → live captions** (Options, on by default): when the engine can't get a video's audio (DRM, login wall, live stream), the extension captions it live instead (about 3 s behind), and says so.

- **Jobs end with their page:** closing, reloading or leaving a page cancels its jobs, and leased jobs (`lease: true`) the extension stops renewing are cancelled by the engine after 90 s and never resumed after a restart.

## Consequences

- **Measured 2026-09-26 in Brave (headless, the extension build):**
  - Controls: delay buttons, typed values, on/off and every shortcut work, and typing in the delay box leaves YouTube's own keys alone.
  - Dragging the button to the bottom-right snaps it there and remembers it.
  - YouTube Shorts: 452 × 804 video captioned; French translation arrived (Qwen3-4B); the next Short was captioned by itself after scrolling.
  - TikTok: the video's audio was fetched through yt-dlp (a 10 s clip with no speech: "No speech found in this video").
  - Instagram: needs the login setting (yt-dlp: "empty media response").
- LLM translation of each short in a feed costs a model swap on a 4 GB GPU (whisper ↔ LLM), so it lags behind fast scrolling. English (Whisper) doesn't.
- German → English on "Ist das Universum unendlich?": the whole 11-min video translated in ~95 s; bilingual first lines on screen ~16–18 s after pressing Caption (two whisper passes on the first piece). whisper-small's English is readable but makes mistakes ("crazy" for _riesig_, "finally" for _endlich_); a larger model or the LLM path is the quality lever.
- Reading browser cookies is sensitive even locally. It stays opt-in, per browser, used only by the engine on this machine for the fetch it is asked to do, and never stored by sublight.

## Alternatives considered

- **Popup-only controls:** interrupt playback, and are unreachable in fullscreen.
- **Free positioning instead of corners:** more to get wrong on resize and fullscreen; four corners cover the need and survive layout changes.
- **Single-key shortcuts (like YouTube's C):** collide with site shortcuts and typing.
- **Ask for a login inside sublight:** would handle credentials; the user's own browser session is safer and needs no new secret.
