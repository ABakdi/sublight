---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0010 — Audio capture strategy (three sources, one pipeline)

**Status:** accepted

## Context

To transcribe, the engine needs audio. Client-side options, in order of desirability:

1. **`HTMLMediaElement.captureStream()`** — captures the element's own audio track directly with zero UX friction. Works for **same-origin / CORS-clean media** (many sites, self-hosted videos). On **cross-origin media it is blocked/tainted** (Chrome mutes or throws), and **DRM/EME content (YouTube's Widevine on most videos) yields black video + muted audio**.
2. **`chrome.tabCapture.capture({ audio: true, video: false })`** — captures the _browser tab's_ audio output (exactly what you hear), works for **any site including YouTube**, requires a user gesture + permission prompt, and captures in real time (you must play the video).
3. **File/project upload** — local files: the player streams the file to the engine ([ADR-0011](0011-local-video-processing.md)); no capture at all.
4. **`yt-dlp` (optional, advanced)** — the engine downloads the audio stream directly (needs network + ToS mindfulness; signature deciphering breaks occasionally).

Capture being **real-time** for online videos (options 1–2) is a feature, not a bug: we can **live-caption while you watch** (roll a ~30 s window through ASR faster-than-realtime), then run the offline **refinement pass** afterward ([ADR-0008](0008-word-level-timestamps.md)).

## Decision

- One internal **CapturedAudio** abstraction; every source produces the same thing: an ordered stream of PCM-or-encoded audio chunks with a `{ mediaTimeStart }` anchor.
- **Default order:** `captureStream()` when the element is CORS-clean → **`tabCapture` (audio-only)** for everything else (this is the common online path) → **upload** for local files → **`yt-dlp`** behind an explicit power-user toggle.
- **DRM-protected streams are out of scope** (capture will yield silence/black; we detect and explain instead of failing silently).
- Live windowing, VAD gating (skip silence), pause/seek semantics — all spec'd in [Spec 08](../../specification/08-Audio-Capture.md).

## Consequences

**Good:** works on nearly everything non-DRM; live captions as a wow feature; the pipeline is source-agnostic so new sources (e.g. `getDisplayMedia`, media elements in same-document players with CORS) are plug-ins.
**Cost:** tabCapture means the user must actually play the video once for transcription (mitigated by yt-dlp toggle + refinement pass reuse); permission prompts need good UX copy; Chrome's `tabCapture` has no Firefox counterpart (its API differs only slightly) — flagged in [ADR-0015](0015-firefox-port.md).

## Alternatives considered

- **yt-dlp only** — dependency + ToS + breakage; relegated to optional toggle.
- **Screen capture (`getDisplayMedia`)** — captures system audio too (ambient noise), worse UX; rejected except as future fallback.

## Links

- [Spec 08 — Audio Capture](../../specification/08-Audio-Capture.md)
- [ADR-0011](0011-local-video-processing.md) · [ADR-0008](0008-word-level-timestamps.md)
- [Spec 10 — failure modes](../../specification/10-Non-Goals-And-Failure-Modes.md)
