---
tags: [specification, non-goals, failure-modes]
status: specified
updated: 2026-09-23
---

# 10 — Non-goals & failure modes

_What sublight deliberately is not, and how every component fails — with detection, impact, and mitigation. This file is the contract for "graceful degradation."_

## 1. Non-goals (explicit "no")

| #   | Non-goal                                                     | Why                                                                                                               |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| N1  | DRM/protected streams (Netflix, Prime, Disney+, Spotify…)    | Technically blocked (encrypted audio), legally messy. UI explains instead.                                        |
| N2  | Cloud/API inference                                          | Privacy is the product ([Req F6](../architecture/Requirements.md)).                                               |
| N3  | Remote/multi-device engine                                   | v1 is one-machine. (Documented as future ADR material.)                                                           |
| N4  | Speech diarization ("who said this")                         | Deferred; speaker markers only from `[SPEAKER]`-style input for now.                                              |
| N5  | OCR/burned-in subtitles                                      | Separate problem; may pair with M09 tooling later.                                                                |
| N6  | Editing _platform_ (multi-user, teams, server sync)          | Local-first single-user tool focused on subtitles-for-language.                                                   |
| N7  | Live **streams** (Twitch etc.) transcription                 | Rolling-window ASR is designed for playback capture; livestream support is a later question, note in checkpoints. |
| N8  | Auto-transcribing podcasts/audiobooks from the _file system_ | Player handles user-opened files only; no filesystem scanning.                                                    |
| N9  | YouTube _downloads_ / video saving                           | yt-dlp is used for **audio** only (optional toggle), never storage of video.                                      |

## 2. Failure-mode matrix

| Area        | Failure                                 | Detection                    | Impact                 | Mitigation                                                                                                |
| ----------- | --------------------------------------- | ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Engine      | Offline/crashed                         | health poll timeout          | No caption jobs        | Player/extension "start engine" cards; SW retry; jobs resumable via idempotency + `jobs.jsonl`            |
| Engine      | Token wrong/rotated                     | 401                          | All calls fail         | Loud pairing re-flow; rotation path in options; error copy includes "how to fix"                          |
| Engine      | GPU OOM                                 | NVML / worker error          | Job fails              | Retry with offload → `base` model; guidance to CPU mode                                                   |
| ASR worker  | Crash mid-job                           | health ping + exit code      | Job failed(retryable)  | Auto-restart + retry (max 3); jobs resumable from chunk boundaries                                        |
| ASR         | Slow (below realtime)                   | buffer pressure metric       | Live captions lag      | Drop to faster model/live window shrink; notice in UI; refinement still produces final                    |
| ASR         | Hallucinated speech on silence/music    | confidence + VAD data        | Wrong cues             | VAD gating; low-confidence cues flagged; corpus metric                                                    |
| Translation | Line mismatch                           | count validation             | Misaligned translation | Retry half-size → proportional re-split with `low-confidence` flag ([07 §2.3](07-ASR-And-Translation.md)) |
| Translation | Overtranslation/emergent content        | style checks                 | Wrong subtitles        | Prompt discipline + glossary enforcement + QA packs per release                                           |
| Capture     | DRM silent stream                       | VAD all-silent while playing | No captions            | Explanatory UI per [08 §7](08-Audio-Capture.md)                                                           |
| Capture     | Tab muted                               | VAD all-silent               | Silence                | "Unmute tab" guidance                                                                                     |
| Capture     | Seek mid-capture                        | `seeking` event              | Wrong timeline         | Re-anchor T₀' + truncate (§[08 §4](08-Audio-Capture.md))                                                  |
| Capture     | Navigation mid-capture                  | capture stop                 | Short capture          | Refine what we got; allow restart                                                                         |
| Overlay     | Host region changes (fullscreen/radius) | ResizeObserver + rAF         | Mis-positioned cues    | Re-measure; clamp to viewport ([05 §3](05-Overlay-Rendering.md))                                          |
| Overlay     | Host page CSS pierces shadow (rare)     | visual e2e screenshots       | Style breakage         | Scoped stylesheet + `all: initial` reset; e2e fixture coverage                                            |
| Playback    | Huge file / slow disk                   | buffering events             | Playback stutter       | Native video behaviour; no action (player is a player)                                                    |
| Storage     | IndexedDB quota                         | QuotaExceededError           | Save fails             | Warn at 80%; export/import escape hatch; purge old projects                                               |
| Model store | Disk full / checksum fail               | install error                | Model unusable         | Refuse install, clear message; disk budget UI                                                             |
| Network     | Model download fails/interrupted        | fetch error                  | No model               | Resume downloads (range requests); retry UI                                                               |

## 3. DRM & protected content

_N1 — the UX contract._

When capture detection says "protected audio", the extension shows:

> "This video's audio is protected and can't be captured. sublight can't add subtitles to it. If a legal download exists, open it in the Sublight Player instead."

No silent failure, ever. Same copy family for mute and autoplay-blocked cases.

## 4. Degraded modes (order of enforcement)

1. **Engine CPU-only** (no CUDA build): everything works, slower; model defaults drop to `base`; translation to NLLB if 3B too slow.
2. **No whisper model installed yet**: UI offers one-click install (models registry) before captioning.
3. **yt-dlp unavailable**: toggle hidden; tab capture path unaffected.
4. **Player without engine**: playback, styling, SRT import/export all work — only intelligence is off. ("If the engine is down, sublight is still a nice player.")

## 5. Test contracts referenced

Every row above has a test: fault-injection suite (engine), fixture pages (overlay), VAD corpus (ASR), capture integration (YouTube/DRM fixtures). See [checkpoints template](../checkpoints/Template.md) — failing rows become checkpoint findings, and fixes land back in the relevant spec.

## 6. Related

- [Requirements — out of scope §6](../architecture/Requirements.md) · [ADR-0010](../architecture/decisions/0010-audio-capture-strategy.md)
- [Checkpoints](../checkpoints/README.md) · [Audits](../audits/README.md)
