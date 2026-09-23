---
tags: [specification, capture]
status: specified
updated: 2026-09-23
---

# 08 — Audio capture

_How sublight gets the audio it transcribes — from inside pages, from tabs, and from local files — without breaking the page or the user's flow._

## 1. Source hierarchy (per [ADR-0010](../architecture/decisions/0010-audio-capture-strategy.md))

| # | Source | Trigger | Works where | Caveats |
|---|---|---|---|---|
| 1 | `captureStream()` on the `<video>` | automatic probe | CORS-clean media, same-origin, self-hosted players | blocked/tainted on cross-origin + EME/DRM |
| 2 | **`tabCapture` (audio-only)** | automatic fallback | **every site incl. YouTube** | real-time only (video must play), permission prompt on first use |
| 3 | Upload of local file | [Player flow](04-Player-App.md) | local files | — |
| 4 | yt-dlp fetch (power toggle) | user enabled | YouTube + many sites | network + ToS; may break on site changes |
| 5 | **Engine resolve/relay for migrated videos** | "Open in Sublight Player" ([04 §9](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017)) | the Player, for page videos the engine can fetch (`media/resolve` → relay or direct fetch, [06 §4.1](06-Engine-Server.md#41-media-resolve--relay-open-in-player)) | needs engine network access; some sites wall their streams |

Rows 1–2 are the **in-page live path** (extension). Rows 3–5 are the **player paths**. Order is decided by probing, not by settings: try 1; if the stream is muted/black/thrown → 2. DRM detection (stream arrives silent/black after 3 s) → surfaced explanation instead of silence ([10 §3](10-Non-Goals-And-Failure-Modes.md#3-drm--protected-content)).

For a *migrated* video the player prefers its own "owns-the-media" sources in this order: engine relay (5) → engine best-effort direct audio fetch of the playback URL (CORS permitting) → in-page live path (1–2, via the extension) → explain. A cross-origin direct URL that the engine can't fetch and the player can't capture (tainted) is the honest gap — copied as "caption this page in place instead".

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

## 3. Chunked streaming to the engine

- Chunks flow over the WS as binary frames (protocol: `WS_BIN/chunk` + metadata frame with `mediaTimeStart`, sequence).
- The engine VAD-gates: `isSilent` chunks recorded but not queued to ASR (live mode) — keeps the rolling window speech-full. Silences still advance the timeline for correct cue gaps.
- Backpressure: client sends at capture rate; WS buffers ~30 s; engine feeds ASR windows; if ASR is slower than realtime (bad GPU day) the client drops frames with a "captioning is falling behind" notice (never unbounded buffering).

## 4. Timeline semantics (pause / seek / speed)

| User action | Behavior |
|---|---|
| Pause | audio goes silent; VAD marks silence; timeline keeps advancing (nothing lost) |
| Resume | continues; no correction needed |
| Seek during capture | **capture restarts** at new position: state `re-anchor` — new T₀' reported, old buffered audio truncated (we discard what's after the seek to avoid wrong captions), UI flash "re-syncing" |
| Speed change | capture is the *actual audio*, so timestamps stay truthful automatically; live window recomputes chunk boundaries |
| Fullscreen / PiP | capture unaffected (element/tab continues) |

## 5. Live captioning loop

- Rolling window: keep the last ~30 s of *speech* audio; ASR runs on window start overlap 2 s; words→cues per [07 §1.3](07-ASR-And-Translation.md); draft cues pushed as `job.partial`.
- Latency budget: capture → window ready ≤ 2 s; ASR (base/small on T1000) ≤ 3 s; total ≤ ~5–8 s behind the spoken word. Measured per release in the [checkpoint](../checkpoints/README.md).
- Gaps: no speech for > 2 s → engine sends `job.state: idle-waiting` to keep UI honest (it's not stuck).

## 6. Capture lifecycle in the extension

1. Permission: `tabCapture` requires a user gesture → the "Caption this video" click is the gesture; Chrome shows the tab-share pill once (documented in UX copy).
2. Start: record `T₀ = video.currentTime`. Stop: user clicks stop, video ends, or tab captured-stopped event (Chrome ends capture on navigation — handled by the SW → refine flow).
3. If the page navigates mid-capture: capture ends → engine **finishes the refine pass over what it got**, overlay keeps last cues; the user can restart.
4. Tab muted → tabCapture yields silence; detect via `isSilent` heuristics and show "unmute tab" guidance.

## 7. Error matrix (surfaced, never silent)

| Symptom | Detection | UX |
|---|---|---|
| DRM/protected | stream silent-black > 3 s OR tabCapture muted | "This video is DRM-protected — sublight can't read its audio." [+ suggestion: download legal copy → player] |
| Cross-origin taint | captureStream throws/black | auto-fallback to tabCapture (no user action) |
| Tab muted | VAD all-silent despite video playing | "Unmute the tab to capture audio." |
| Autoplay-blocked page | video paused at start | "Play the video first, then start captions." |
| Capture ended by navigation | capture stop event + page unload | refine available for the captured portion |
| ASR falling behind | buffer pressure > 20 s | "Captioning is running slower than real time — consider the base model or wait for refinement." |

## 8. Related

- [Data-flow diagram 1](../architecture/diagrams/Data-Flow.md) · [07 §1.4 anchoring](07-ASR-And-Translation.md#14-the-sync-equation) · [09 extension capture wiring](09-Browser-Extension.md)
- ADR [0010](../architecture/decisions/0010-audio-capture-strategy.md) · [M05](../plan/milestones/05-Extension-Overlay.md)
- Migrated-video audio: [04 §9.4](04-Player-App.md#94-captioning-a-migrated-video) · [06 §4.1](06-Engine-Server.md#41-media-resolve--relay-open-in-player) · [ADR-0017](../architecture/decisions/0017-open-in-player.md) · [M05b](../plan/milestones/05b-Open-in-Player.md)