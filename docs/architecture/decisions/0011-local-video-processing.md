---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0011 — Local file processing: player streams file to engine, engine extracts audio

**Status:** accepted

## Context

For local files (downloaded movies), the options for getting audio to the engine:

1. **ffmpeg.wasm inside the browser** — the player extracts audio to a compact WAV/MP3, uploads only that. ✓ small uploads. ✗ ~30 MB wasm download per load, Web Worker complexity, re-encoding on the CPU of the browsing tab.
2. **Stream the whole video to the engine once** — the engine's ffmpeg extracts + normalizes (16 kHz mono PCM WAV — Whisper's home format) and caches by content hash. ✓ zero wasm, one code path (the engine already owns ffmpeg for everything), simple; loopback transfer is fast (a 2 GB film ≈ tens of seconds on the local link). ✗ the file traverses the loopback interface once.

Also decisive: the **File System Access API** gives the *player* a handle, not the engine a path — the browser is the only component legally able to read the file. So whether we like it or not, bytes flow browser → engine.

## Decision

- **v1: the player streams the opened file to the engine** (`PUT /v1/media` streaming over localhost), engine extracts/normalizes audio with its bundled ffmpeg, stores audio + hashes it (`sha256(audio-bytes)`), and caches transcription per hash ([Spec 06 §5](../../specification/06-Engine-Server.md)).
- The player **never** sends the whole file if the user cancelled/ended the job — upload is tied to a job and cancellable; the media cache is deletable from the options UI.
- **ffmpeg.wasm is not used in v1**; revisit only if localhost upload ever becomes a bottleneck (it won't at these sizes).

## Consequences

**Good:** one audio pipeline everywhere (engine-side ffmpeg); no wasm runtime; content-hash cache makes re-transcription (different model, different language) free.
**Cost:** one full-file transfer per unique file; disk cache growth managed by a size cap + eviction policy; privacy note: the file crosses only loopback and is never stored beyond cache.

## Alternatives considered

- **Player-side ffmpeg.wasm extraction** — works, but duplicates engine ffmpeg, costs wasm size/reload, browser-thread CPU; rejected for v1, marginal later.
- **Passing the file path to the engine** (OS-level) — impossible from a browser context without a native host ([ADR-0006](0006-engine-transport.md)); explicitly out.

## Links

- [Spec 04 — Player app, local files](../../specification/04-Player-App.md)
- [ADR-0006](0006-engine-transport.md) · [Spec 06 — media cache](../../specification/06-Engine-Server.md)