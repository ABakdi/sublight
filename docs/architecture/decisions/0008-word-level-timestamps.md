---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0008 — Word-level timestamps + anchoring + refinement = "perfect" sync

**Status:** accepted

## Context

"Perfectly synced to the audio" is the defining quality bar. Whisper provides segment timestamps (good to ~±200–500 ms) and, with word-level output, per-word timestamps (better). But two systematic problems remain:

1. **The audio we transcribe rarely starts at video time 0.** Online, capture begins mid-video (T₀ = `video.currentTime` at capture start); offline, audio starts at 0. If we ignore T₀, every cue is offset by T₀.
2. **Drift.** Whisper timestamps are relative to the captured audio stream; the stream is the real audio, so there is no intrinsic drift — but _pipeline_ artifacts (buffer delay, MediaRecorder start latency, tab-audio capture startup) add small offsets.

## Decision

Sync is a three-stage pipeline, not a heuristic:

1. **Word timestamps from ASR** — whisper.cpp with word-level output (`--max-len`, JSON with `tokens[].t`). These are the raw material.
2. **Anchoring** — every job is anchored: `videoTime = audioSegmentStart + T₀ + δ`, where **T₀** is captured at capture start and **δ** is a fine offset estimated at the first speech onset (cross-checking a few loud, unambiguous onsets) and adjustable by the user with a ±50 ms nudge UI persisted per project.
3. **Refinement pass** — after capture ends (or on demand), re-run ASR on the full audio with a heavier model if available, produce final word-level cues, and **re-anchor** at multiple control points (every ~2 min of strong speech) to bound cumulative error < 500 ms on a 2 h video.

Cue boundaries are then rounded to integer milliseconds and gapped/merged per [Spec 02](../../specification/02-Data-Model.md) rules (min 200 ms, no overlap).

## Consequences

**Good:** live captions appear while watching (stage 1+2 in real-time), then the refinement pass upgrades them in place without changing what the user already saw — only tightening.
**Cost:** two transcription passes for final output (live draft + refined); cache keyed by audio content hash amortizes this ([Spec 06](../../specification/06-Engine-Server.md)); the anchoring math must be specified precisely ([Spec 07 §1](../../specification/07-ASR-And-Translation.md)).

## Alternatives considered

- **Rely on Whisper segment timestamps only** — visibly off for subtitle reading; rejected.
- **Forced alignment with wav2vec2 (whisperX-style)** — highest precision but adds a Python/ONNX dependency; deferred to a later milestone if whisper.cpp word timestamps prove insufficient on real audio. Recorded as an open question in [Spec 10](../../specification/10-Non-Goals-And-Failure-Modes.md).

## Links

- [Spec 07 §1 — anchoring math + refinement](../../specification/07-ASR-And-Translation.md)
- [Spec 02 — cue model](../../specification/02-Data-Model.md)
- [Requirements F4](../../architecture/Requirements.md)
