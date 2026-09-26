---
tags: [specification, capture]
status: specified
updated: 2026-09-23
---

# 08 — Audio capture

_How sublight gets the audio it transcribes — from inside pages, from tabs, and from local files — without breaking the page or the user's flow._

## 1. Source hierarchy (per [ADR-0010](../architecture/decisions/0010-audio-capture-strategy.md))

| #   | Source                                        | Trigger                                                                                               | Works where                                                                                                                                                       | Caveats                                                                 |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `captureStream()` on the `<video>`            | automatic probe                                                                                       | CORS-clean media, same-origin, self-hosted players                                                                                                                | blocked/tainted on cross-origin + EME/DRM                               |
| 2   | **`tabCapture` (audio-only)**                 | automatic fallback                                                                                    | **every site incl. YouTube**                                                                                                                                      | real-time only (video must play), permission prompt on first use        |
| 3   | Upload of local file                          | [Player flow](04-Player-App.md)                                                                       | local files                                                                                                                                                       | —                                                                       |
| 4   | **Engine fetch, ahead of playback (default)** | "Caption this video" / "Download SRT" ([§6a](#6a-captions-ahead-of-playback-adr-0020))                | recorded videos with a direct http(s) src, or any site yt-dlp supports (YouTube, Vimeo…)                                                                          | network + ToS; yt-dlp may break on site changes; no DRM or live streams |
| 5   | **Engine resolve/relay for migrated videos**  | "Open in Sublight Player" ([04 §9](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017)) | the Player, for page videos the engine can fetch (`media/resolve` → relay or direct fetch, [06 §4.1](06-Engine-Server.md#41-media-resolve--relay-open-in-player)) | needs engine network access; some sites wall their streams              |

Row 4 is the **default** for page videos since [ADR-0020](../architecture/decisions/0020-caption-ahead-of-playback.md): captions are made ahead of the playhead and shown at their exact time. Rows 1–2 are the **in-page live path** (extension), now the fallback for live streams and videos the engine can't fetch. Rows 3–5 are the **player paths**. Order is decided by probing, not by settings: try 1; if the stream is muted/black/thrown → 2. DRM detection (stream arrives silent/black after 3 s) → surfaced explanation instead of silence ([10 §3](10-Non-Goals-And-Failure-Modes.md#3-drm--protected-content)).

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

- As soon as the previous pass is done and ≥ 0.5 s of new audio arrived (chunks are 0.5 s), the window from the last committed word to now (≤ 28 s) goes through whisper, with the last ~200 characters of committed text as the prompt. Silent windows (< −60 dB) are skipped.
- Each pass **cuts the window's leading silence** to 300 ms before the first speech onset (also a short leftover of the previous word followed by a pause). Whisper stamps the first word at the start of the audio, and after a long pause every later word could slip by one: a JFK window from 1.9 s timed "not" where "ask" is spoken.
- Each pass sets whisper's **encoder context to the window** (`audio_ctx` = 50 frames/s × 1.3, 384–1500): the encoder otherwise always runs a full 30 s. JFK, whisper-small, T1000: 1500 → 1.97 s, 768 → 1.08 s, same words and times. (An earlier test that rejected `audio_ctx` used contexts shorter than the audio, which truncates it.)
- A window's first words that repeat the last committed ones are dropped ("And And so my fellow…").
- Words ending more than **3 s** before the newest audio **commit** (whisper still revises the tail); the rest are drafts. Both go out as one `job.partial` track in **media time** (`draft: true`). A pass over an almost-full window, or after stop, commits everything.
- **Stop** (`POST /v1/live/:jobId/stop`) → a final pass, then the **refinement pass**: each contiguous playing stretch (split at anchors) is transcribed again with full context, in 2-min chunks. It replaces the live words unless it has fewer than half of them. (An 80 % rule kept garbled drafts: repeats and loops made them look longer.) Then the job is `done` with the final track.
- No audio for 60 s, or only silence for 10 min (a paused tab left captioning), ends the session by itself.
- **One live session at a time** (the GPU runs one job): a new live job cancels queued ones and makes a running one finish at once with its live words, without refinement. Before this, a forgotten session kept the GPU slot and every new one sat in the queue showing "Listening · 0 cues". Live jobs are cancelled, not resumed, after an engine restart (their audio was streamed).
- Display: drafts arrive a few seconds after their words were spoken, when the playhead has moved on; shown at their true time they'd never be seen. The page shows drafts behind by a **steady delay** (`apps/extension/src/liveDelay.ts`): each draft's earliest new word shows how late words arrive; the target is the largest of the last 8 plus 250 ms, so every word is there when its turn comes and words appear in the rhythm they were spoken. The delay moves toward the target at most 0.25 ms per ms (caption clock 0.75–1.25×): a jump would run the caption clock backwards (captions vanish and come back) or forwards (a burst of words). It resets on seek. The final track is exact. (The first version followed the last word of each draft; over silence that estimate climbed to 8 s and fell back when speech resumed, which is what made captions pop in and out.)
- **Draft and refine models**: whisper-small for both by default; Options can pick others. whisper-base was tried for drafts (a pass in ~0.9 s) and garbled too much to read ("ask what you're doing").
- **Measured 2026-09-26, second round** (JFK in Chromium through the extension, per word: video time when first visible − time spoken): passes every ~0.6 s; live words visible **~3.0 s after being spoken (median; 2.4–4.8 s)**, at a steady offset; final (after Stop) words **within 20 ms** of the speech onsets ("And" 330/330, "ask" 3290/3290 and 8171/8190), correct text. Before this round: 5 s median, garbled drafts, and a final SRT with doubled and mistimed words. Live captions can't be much earlier than 2–3 s on this GPU (they can only hear audio that has played); exact-from-the-start captions for recorded videos need the audio ahead of playback (engine fetch, M05b).
- Round one (same day): median 1.9 s with whisper-base drafts, but the text was poor.
- Earlier measurement: JFK streamed through the engine with whisper-small → words land on the media timeline within ±150 ms of speech onsets; in Chromium/Brave the first caption appears **6–8 s** after starting (startup + first 1 s chunk + first pass + display delay); drafts run ~4 s behind.

## 6. Capture lifecycle in the extension

1. Source order (as built): the content script tries `video.captureStream()` first. No prompt; works on CORS-clean media, **including YouTube** (MSE, non-DRM), verified in Brave. If it throws (cross-origin media), or its audio stays silent for 4 s while the video plays unmuted (tainted/DRM), the SW switches to **tabCapture**: `tabCapture.getMediaStreamId` → an **offscreen document** (`offscreen.html`, reason `USER_MEDIA`) opens the stream and **plays it back** (capturing a tab mutes it for the user). tabCapture needs a real invocation of the extension on that page (toolbar popup, **Alt+Shift+L**), which grants `activeTab`.
2. Start: record `T₀ = video.currentTime`. Stop: user clicks stop, video ends, or tab captured-stopped event (Chrome ends capture on navigation — handled by the SW → refine flow).
3. If the page navigates mid-capture: capture ends → engine **finishes the refine pass over what it got**, overlay keeps last cues; the user can restart.
4. Tab muted → tabCapture yields silence; detect via `isSilent` heuristics and show "unmute tab" guidance.

## 6a. Captions ahead of playback (ADR-0020)

Code: `apps/engine/src/asr/ahead.ts`, `apps/engine/src/media/remote.ts`, `apps/extension/src/captions*.ts`.

- **Resolve** (`resolveRemote`): the `<video>`'s `http(s)` src if ffprobe reads it (Referer = page, the browser's User-Agent); else `yt-dlp -J -f bestaudio/best --js-runtimes node:<engine's node>` on the page or embed URL (live streams refused). Unreachable → `MEDIA_UNREACHABLE` (422) with yt-dlp's reason; the popup offers live captions.
- **Pieces** (`nextRange`): the first piece is 30 s from the playhead, then 2-minute pieces forward, then the part before the playhead; no slivers under 10 s. After a seek (`POST /v1/url/:id/focus`), the next piece is 30 s from the new position.
- **Per piece:** `ffmpeg -ss … -t …` over Range requests (1 s of context either side) → 16 kHz mono → leading silence cut → whisper (prompt = the preceding piece's words) → onset snapping → words owned by the piece; touching pieces drop words already heard. If ffmpeg returns much less audio than asked (a site without Range support, a dropped connection), the job fails rather than passing it off as silence.
- **Output:** each piece sends the whole track (`job.partial`) with `coverage` and `mediaDurationMs`; the final track covers the video and is cached per canonical page URL (start-time and tracking parameters dropped), model, task and language.
- **In the page:** cues show at media time with no delay. "Pause until captions are ready" (default on) pauses where `coverage` doesn't reach 3 s past the playhead, shows "Captioning this part…", and resumes by itself; pressing play overrides it until the next seek. If the element's duration doesn't match `mediaDurationMs` (an ad in the same `<video>`), the captions hide until the video is back.
- **Translate to** ([ADR-0021](../architecture/decisions/0021-quick-controls-and-short-video-feeds.md)): English re-runs the `url` job with `task: "translate"` (Whisper, still ahead of playback); other languages send the finished transcript to a `translate` job (LLM), and the transcript shows until it's ready. Moving to another video cancels a translation still running.
- **Measured 2026-09-26** (T1000, whisper-small):
  - YouTube: resolve ~2.5 s; first captions at the playhead in ~10 s (held meanwhile); 2-minute pieces in ~15 s (~8× faster than playback); a 15-min video's full SRT in 94 s.
  - Timing in the extension: words appear a median **23–28 ms** after their timestamps (p90 ~40 ms, the test's 30 ms sampling).
  - JFK from a direct file: "And" spoken at 330 ms / shown at 357; "ask" 3290 / 3324 and 8190 / 8215.

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
