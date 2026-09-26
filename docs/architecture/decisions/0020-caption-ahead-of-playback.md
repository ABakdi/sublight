---
tags: [architecture, decision]
status: accepted
date: 2026-09-26
---

# ADR-0020: Caption page videos ahead of playback (the engine fetches the audio)

**Status:** accepted. Amends [ADR-0010](0010-audio-capture-strategy.md): engine fetching (yt-dlp or the page's direct media URL) becomes the **default** for recorded videos; tab/element capture becomes the fallback for live streams and videos the engine can't reach.

## Context

Live captioning ([Spec 08 §5](../../specification/08-Audio-Capture.md#5-live-captioning-loop-as-built)) can only hear audio once it has played. On the reference GPU (Quadro T1000) a whisper-small pass takes ~0.6–2 s, so live words reach the screen **2–3 s after they are spoken** at best. Two rounds of fixes made that delay steady and the text good, but users judge subtitles by timing, and "3 s late" reads as broken. Only the final track (after Stop) was exact, and nobody wants to watch a video twice.

Measured on the way to this decision (2026-09-26):

- `yt-dlp` resolves a YouTube page to its audio URL in **~2.5 s**; `ffmpeg -ss … -t …` reads a **30 s slice from minute 10 in ~1.1 s** over HTTP Range requests, without downloading the rest.
- whisper-small transcribes a 2-minute piece in **~15 s** on the T1000: **~8× faster than playback**.
- The file-transcription pipeline (the same whisper passes, onset snapping, punctuation and loop fixes) puts words within **~20–80 ms** of speech onsets ([Spec 07 §1.7](../../specification/07-ASR-And-Translation.md#17-quality-gates-measured-not-assumed)).

So for any recorded video the engine can fetch, it can stay far ahead of the viewer, and every caption can be shown **at its exact media time**, with no display delay.

## Decision

- **New job type `url`** ([Protocol §2](../../specification/03-Protocol.md)): `{ pageUrl, mediaUrl?, userAgent?, model, params: { language, task, fromMs } }`. The engine:
  1. **Resolves the audio:** the `<video>`'s own `http(s)` src when ffprobe can read it (sent with the page as Referer and the browser's User-Agent), else **yt-dlp** on the page (or embed) URL, `bestaudio`, with Node as its JavaScript runtime.
  2. **Transcribes in pieces around the playhead:** the first piece is **30 s from `fromMs`** (captions within ~5–10 s), then **2-minute pieces** forward to the end, then the part before the playhead. Each piece is fetched with 1 s of context either side, its leading silence cut, then run through whisper, onset snapping and the punctuation and loop filters.
  3. **Streams drafts:** each finished piece sends the whole track so far (`job.partial`) with `coverage` (the captioned ranges) and `mediaDurationMs`. The final track is the whole video, and it is cached by the canonical page URL, so reopening a video is instant.
  4. **Follows seeks:** `POST /v1/url/:jobId/focus { mediaMs }` makes the next piece start at the new position (a 30 s piece again).
  5. **One `url` job at a time** (the GPU runs one job): a newer one cancels the older one.
- **Extension:**
  - **"Caption this video"** is the main action.
  - Captions show at exact media time, word by word or by sentence.
  - **"Pause until captions are ready"** (on by default): when the playhead reaches a part that isn't captioned yet (the start, or after a seek), the video pauses with "Captioning this part…" and resumes by itself. Pressing play wins until the next seek.
  - **"Download SRT"**, word by word or by sentence, transcribes the whole video (reusing the running job) and saves the file when done, even if the tab navigates away.
  - **Live captions** move under "More", for live streams and videos the engine can't fetch. A failed fetch offers them directly.
- **yt-dlp is pinned and verified:** `pnpm engine:setup-ytdlp` installs the standalone release `2026.08.19` (no Python) into `~/.sublight/bin` after checking its SHA-256. It is used for **audio only**, streamed in pieces and never saved as a video file ([Spec 10 N9](../../specification/10-Non-Goals-And-Failure-Modes.md)).

## Consequences

- **Exact timing for recorded videos** on any site the engine can fetch: in the extension, words appeared a median **23–28 ms after their timestamps** on YouTube, and within ~30 ms of the speech on a direct file (JFK: "ask" spoken 3290 ms, shown 3324 ms).
- **A short wait at the start** (~5–10 s, or after a seek into an uncaptioned part), handled by the hold instead of wrong captions. A 15-minute video's full SRT takes ~1.5 min.
- **Network and site dependence:** the engine now makes outbound requests to the video's host. yt-dlp can break when sites change (update the pin), some sites need a login (cookies are out of scope for now), DRM content can't be fetched, and live streams have no audio ahead. All of these fall back to live captions with a clear message ("couldn't get this video's audio: …").
- **Ads on YouTube-like players** play in the same `<video>` with a different length. The overlay hides while the element's duration doesn't match the captioned media, rather than showing captions against the ad's clock.
- **ToS:** fetching a stream's audio for personal, local captioning is the same trade-off [ADR-0010](0010-audio-capture-strategy.md) accepted for the optional toggle; it is now the default path, and the docs say so.

## Alternatives considered

- **Keep live capture as the main path and shrink the delay:** measured limits of ~2–3 s on this GPU (pass time plus the audio needed to decide words); never exact.
- **Download the whole video first, then caption:** simplest, but a 1-hour video would wait minutes before the first caption. Pieces around the playhead give captions in seconds and the whole file soon after.
- **Delay the video instead of the captions** (buffer playback in the page): not possible for MSE players without re-implementing them, and still bounded by live transcription quality.
- **yt-dlp from the system PATH:** version drift and supply-chain risk; a pinned, hash-checked binary matches how whisper.cpp and llama.cpp are handled ([ADR-0016](0016-model-licensing.md)).
