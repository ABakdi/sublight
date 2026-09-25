---
tags: [specification, capture]
status: specified
updated: 2026-09-23
---

# 08 — Audio capture

_How sublight gets the audio it transcribes — from inside pages, from tabs, and from local files — without breaking the page or the user's flow._

## 1. Source hierarchy (per [ADR-0010](../architecture/decisions/0010-audio-capture-strategy.md))

| #   | Source                                       | Trigger                                                                                               | Works where                                                                                                                                                       | Caveats                                                          |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `captureStream()` on the `<video>`           | automatic probe                                                                                       | CORS-clean media, same-origin, self-hosted players                                                                                                                | blocked/tainted on cross-origin + EME/DRM                        |
| 2   | **`tabCapture` (audio-only)**                | automatic fallback                                                                                    | **every site incl. YouTube**                                                                                                                                      | real-time only (video must play), permission prompt on first use |
| 3   | Upload of local file                         | [Player flow](04-Player-App.md)                                                                       | local files                                                                                                                                                       | —                                                                |
| 4   | yt-dlp fetch (power toggle)                  | user enabled                                                                                          | YouTube + many sites                                                                                                                                              | network + ToS; may break on site changes                         |
| 5   | **Engine resolve/relay for migrated videos** | "Open in Sublight Player" ([04 §9](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017)) | the Player, for page videos the engine can fetch (`media/resolve` → relay or direct fetch, [06 §4.1](06-Engine-Server.md#41-media-resolve--relay-open-in-player)) | needs engine network access; some sites wall their streams       |

Rows 1–2 are the **in-page live path** (extension). Rows 3–5 are the **player paths**. Order is decided by probing, not by settings: try 1; if the stream is muted/black/thrown → 2. DRM detection (stream arrives silent/black after 3 s) → surfaced explanation instead of silence ([10 §3](10-Non-Goals-And-Failure-Modes.md#3-drm--protected-content)).

For a _migrated_ video the player prefers its own "owns-the-media" sources in this order: engine relay (5) → engine best-effort direct audio fetch of the playback URL (CORS permitting) → in-page live path (1–2, via the extension) → explain. A cross-origin direct URL that the engine can't fetch and the player can't capture (tainted) is the honest gap — copied as "caption this page in place instead".

## 2. The CapturedAudio contract

Every source produces the same thing:

```ts
interface CapturedAudio {
  anchor: { mediaTimeStart: number };   // T₀
  async *chunks(): AsyncIterable<AudioChunk>;
  // AudioChunk = { pcm16kS16le: Blob | Uint8Array; streamTimeMs: number; isSilent: boolean }
  stop(): void;
}
```

- Chunks are ~5 s of 16 kHz mono PCM (opaque contract; nothing else enters the engine).
- `streamTimeMs` = capture-relative time (starts 0); overlay maps to video via §4.

## 3. Streaming to the engine (as built, M05)

- The capture tap (`apps/extension/src/capture.ts`) turns any `MediaStream` into **~1 s chunks of 16 kHz mono s16le**, stamped with the **wall-clock time the first sample was heard** (callback time − buffer duration − `baseLatency`). Web Audio `ScriptProcessor` (a worklet would need a separately loaded module, awkward from a content script).
- Chunks go page/offscreen → SW as base64 runtime messages (runtime messages are JSON), then SW → engine as **`POST /v1/live/:jobId/audio?wallMs=…`** with the raw PCM, in order. HTTP instead of the planned WS binary frames: same auth/origin checks, ordering by a promise chain, no framing protocol to maintain; at 32 kB/s on loopback the overhead is irrelevant.
- The engine appends chunks to a per-job scratch file (`jobs/live/<id>.pcm`), so hours of audio don't sit in memory.

## 4. Timeline semantics (as built)

Capture time ≠ media time: the video can pause, seek, buffer or change speed. The content script sends a **playback anchor** `{ wallMs, mediaMs, rate, playing }` at start and on `play`, `playing`, `pause`, `waiting`, `seeked`, `ratechange`, `ended` (`POST /v1/live/:jobId/anchor`). The engine maps every word: find the last anchor before the word's wall time → `mediaMs + (wall − anchor.wallMs) × rate` while playing, frozen while paused.

| User action       | Behavior                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pause / buffering | anchor `playing: false`; words heard then are dropped (it's silence anyway)                                                         |
| Resume            | new anchor; mapping continues from the paused position                                                                              |
| Seek              | new anchor at the new position; later words land there. Re-watched ranges are **replaced** by the newer words (`mergeByMediaRange`) |
| Speed change      | anchor with the new `rate`; media time advances at that rate                                                                        |
| Fullscreen / PiP  | capture unaffected                                                                                                                  |

## 5. Live captioning loop (as built)

Code: `apps/engine/src/live/`.

- Every **1.5 s**, if ≥ 1 s of new audio arrived since the last pass, the window from the last committed word to now (≤ 28 s) goes through whisper, with the last ~200 characters of committed text as the prompt. Silent windows (< −60 dB) are skipped.
- Words ending more than **3 s** before the newest audio **commit** (whisper still revises the tail); the rest are drafts. Both go out as one `job.partial` track in **media time** (`draft: true`). A pass over an almost-full window, or after stop, commits everything.
- **Stop** (`POST /v1/live/:jobId/stop`) → a final pass, then the **refinement pass**: each contiguous playing stretch (split at anchors) is transcribed again with full context, in 2-min chunks. It replaces the live words unless it has fewer than 80 % of them (never regress). Then the job is `done` with the final track.
- No audio for 60 s ends the session by itself (tab closed, extension reloaded).
- Display: drafts arrive a few seconds after their words were spoken, when the playhead has moved on; shown at their true time they'd never be seen. The page shows drafts **delayed by the measured lag** (smoothed, ≤ 8 s); the final track is exact.
- Measured: JFK streamed through the engine with whisper-small → words land on the media timeline within ±150 ms of speech onsets; in Chromium/Brave the first caption appears **6–8 s** after starting (startup + first 1 s chunk + first pass + display delay); drafts run ~4 s behind.

## 6. Capture lifecycle in the extension

1. Source order (as built): the content script tries `video.captureStream()` first. No prompt; works on CORS-clean media, **including YouTube** (MSE, non-DRM), verified in Brave. If it throws (cross-origin media), or its audio stays silent for 4 s while the video plays unmuted (tainted/DRM), the SW switches to **tabCapture**: `tabCapture.getMediaStreamId` → an **offscreen document** (`offscreen.html`, reason `USER_MEDIA`) opens the stream and **plays it back** (capturing a tab mutes it for the user). tabCapture needs a real invocation of the extension on that page (toolbar popup, **Alt+Shift+L**), which grants `activeTab`.
2. Start: record `T₀ = video.currentTime`. Stop: user clicks stop, video ends, or tab captured-stopped event (Chrome ends capture on navigation — handled by the SW → refine flow).
3. If the page navigates mid-capture: capture ends → engine **finishes the refine pass over what it got**, overlay keeps last cues; the user can restart.
4. Tab muted → tabCapture yields silence; detect via `isSilent` heuristics and show "unmute tab" guidance.

## 7. Error matrix (surfaced, never silent)

| Symptom                     | Detection                                     | UX                                                                                                          |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| DRM/protected               | stream silent-black > 3 s OR tabCapture muted | "This video is DRM-protected — sublight can't read its audio." [+ suggestion: download legal copy → player] |
| Cross-origin taint          | captureStream throws/black                    | auto-fallback to tabCapture (no user action)                                                                |
| Tab muted                   | VAD all-silent despite video playing          | "Unmute the tab to capture audio."                                                                          |
| Autoplay-blocked page       | video paused at start                         | "Play the video first, then start captions."                                                                |
| Capture ended by navigation | capture stop event + page unload              | refine available for the captured portion                                                                   |
| ASR falling behind          | buffer pressure > 20 s                        | "Captioning is running slower than real time — consider the base model or wait for refinement."             |

## 8. Related

- [Data-flow diagram 1](../architecture/diagrams/Data-Flow.md) · [07 §1.4 anchoring](07-ASR-And-Translation.md#14-the-sync-equation) · [09 extension capture wiring](09-Browser-Extension.md)
- ADR [0010](../architecture/decisions/0010-audio-capture-strategy.md) · [M05](../plan/milestones/05-Extension-Overlay.md)
- Migrated-video audio: [04 §9.4](04-Player-App.md#94-captioning-a-migrated-video) · [06 §4.1](06-Engine-Server.md#41-media-resolve--relay-open-in-player) · [ADR-0017](../architecture/decisions/0017-open-in-player.md) · [M05b](../plan/milestones/05b-Open-in-Player.md)
