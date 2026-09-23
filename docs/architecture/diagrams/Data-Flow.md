---
tags: [architecture, diagram]
status: accepted
updated: 2026-09-23
---

# Data flow — the three core journeys

> Two partners: [Component diagram](Components.md) (actors) and [Deployment diagram](Deployment.md) (processes/ports).

## 1. Online video — live captioning while you watch (then refinement)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Page as Any site (YouTube…)
    participant CS as Content script
    participant SW as Service worker
    participant ENG as Engine
    participant WSr as whisper.cpp
    User->>Page: plays video
    User->>CS: clicks "Caption this video"
    CS->>Page: capture tab audio (tabCapture) / same-origin captureStream
    loop while video plays
        CS->>ENG: stream audio chunks (WS) + anchor {mediaTimeStart=T0}
        ENG->>WSr: rolling ~30 s window, word timestamps
        WSr-->>ENG: segments + words
        ENG-->>CS: job.progress + draft cues (WS)
        CS->>Page: render live cue in overlay (T0 + streamTime)
    end
    User->>CS: stops capture
    ENG->>WSr: refinement pass (full audio, heavier model)
    WSr-->>ENG: full word-level transcript
    ENG-->>SW: final cues (re-anchored, gapped, merged)
    SW->>ENG: POST /v1/jobs translate {targetLang}
    ENG-->>SW: translated track
    SW->>CS: tracks ready
    CS->>Page: render final styled bilingual/single track
```

## 2. Local file — batch captioning in the Player

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant PL as Player app
    participant FS as File System Access API
    participant ENG as Engine
    participant FF as ffmpeg
    participant WSr as whisper.cpp
    participant LL as llama.cpp
    User->>PL: opens video file
    PL->>FS: open read stream from file handle
    PL->>ENG: PUT /v1/media (stream file), job {type: transcribe}
    ENG->>FF: extract + normalize → 16 kHz mono PCM (hash = H)
    FF-->>ENG: audio.wav
    alt cache hit on H
        ENG-->>PL: cached cues (skip ASR)
    else cache miss
        ENG->>WSr: transcribe full audio (word timestamps)
        WSr-->>ENG: segments + words
        ENG->>LL: translate paragraphs (target language)
        LL-->>ENG: translated lines
    end
    ENG-->>PL: final tracks (WS progress throughout)
    PL->>User: overlay renders; user styles, edits, exports SRT
```

## 3. Translation on existing transcript

```mermaid
sequenceDiagram
    autonumber
    participant U as User (player or extension)
    participant E as Engine
    participant LL as llama.cpp
    U->>E: POST /v1/jobs {type: translate, track, targetLang, glossary?}
    E->>E: sentences → paragraphs (≤1500 chars)
    loop each paragraph
        E->>LL: chat.completions (numbered lines, style rules)
        LL-->>E: translated lines (validated count)
    end
    E-->>U: translated track (1:1 cue mapping, same timings)
    U->>U: switch overlay track / export SRT
```

## Anchoring math (referred to by all flows)

`videoTime(cue) = audioStreamTime(cue) + T₀ + δ`

- `T₀` = `video.currentTime` when capture began (or 0 for local files).
- `δ` = fine offset from first-speech-onset cross-check; user-adjustable ±50 ms.
- Refinement re-anchors every ~2 min of strong speech to bound drift. Full derivation in [Spec 07 §1](../../specification/07-ASR-And-Translation.md).