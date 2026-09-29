# Changelog

All notable changes to sublight. Versions follow [semver](https://semver.org);
every package in the repository shares one version. `node scripts/release.mjs`
moves **Unreleased** under a new version.

## [Unreleased]

### Fixes (Beta-1 checkpoint)

- A new video's captions no longer wait behind the previous video's audio fetch.
- Following the next video of a feed starts one captioning job instead of two.
- A translation that repeats a line for a different source is retried instead of shifting the lines after it.
- Page videos whose link stops working once their page stops playing (vinovo.to) play and caption in the Player: the engine keeps a copy while the link works, and names a refused link instead of "Unsupported URL".

### Extension

- Refined live captions translate to any language from the quick controls, with "Show both" and SRT download of the translation.
- Options → Caption style: text and background colors, font, weight, edge, letters, alignment and opacity, with a live preview; open pages restyle at once.

### Security (baseline pass 1)

- Page-supplied URLs reach only the internet (`allowPrivateNetworks` opts in); the relay serves media only; ffmpeg reads remote inputs over network protocols only; request bodies and Player downloads are bounded.
- Worker servers need a per-launch secret; their binaries are checked against recorded checksums at startup.
- Web pages can't drive sublight through its content script; the Player asks before opening a handed-over video.
- Translation is hardened against instructions in the audio.
- Private data directory; finished jobs are forgotten after 30 days; cached audio can be cleared from the Player.
- The Vite dev Player is trusted only when developing (`SUBLIGHT_DEV=1`).

## [0.1.0] — Beta 1

The first installable sublight: see [INSTALL.md](INSTALL.md).

### Engine

- Local speech recognition with whisper.cpp (GPU when available) and translation with Qwen3-4B on llama.cpp, or to English straight from the audio.
- Captions for page videos made **ahead of playback** (yt-dlp), starting at the playhead and following seeks; live captions from tab audio where that isn't possible.
- Bilingual jobs: original and translation, timed to the original's words.
- Job queue with GPU scheduling, leases for jobs only an open tab wants, recovery after restart, and a normalized-audio cache.
- Relays page videos (including HLS/DASH) to the Player as one seekable file; refuses DRM-protected streams up front.
- One-click pairing through the engine's own approval page; "Unpair every app" (Options) or `token --rotate` replaces the token.
- Model manager: verified installs from pinned revisions, removal, disk-space checks.
- Serves the Player at `http://127.0.0.1:17420`.
- `sublight-engine` command: `start [--detach]`, `stop`, `status`, `token`, `transcribe`, `autostart enable|disable|status` (systemd user unit, macOS LaunchAgent).

### Extension

- Captions on any video page, ahead of playback or live (popup, Alt+Shift+C / Alt+Shift+L).
- Word-by-word or sentence captions, bilingual display, translation to any language.
- Quick controls on the video (on/off, translate, delay in 100 ms steps), keyboard shortcuts, portrait feeds (TikTok, Instagram, Shorts) that follow the video in view.
- SRT download (whole video, word by word or by sentence), hide the site's own captions, Open in Sublight Player.

### Player

- Local files and page videos from the extension (direct, HLS, DASH, or through the engine's relay).
- Caption with progress and drafts, translate tracks, bilingual toggle, styles, sync nudge, IndexedDB projects, SRT/VTT import and export.
- Models tab: install, remove, disk space.
