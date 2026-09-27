# Changelog

All notable changes to sublight. Versions follow [semver](https://semver.org);
every package in the repository shares one version. `node scripts/release.mjs`
moves **Unreleased** under a new version.

## [Unreleased]

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
