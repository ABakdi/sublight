# Sync-accuracy corpus

The yardstick for the "perfect sync" promise ([Requirements F4](../../docs/architecture/Requirements.md)): a small
ground-truth corpus of hand-timed word boundaries, plus the metric script that
measures the engine against it.

## Layout

```
e2e/sync-corpus/
├─ corpus.json              # clip metadata + expected cues with word times
├─ audio/                   # recordings (FLAC 16 kHz mono) — pending
├─ transcripts/             # engine ASR output per clip: <id>.cues.json
└─ measure.mjs              # the report (run via `pnpm sync:measure`)
```

`corpus.json` is the schema; `en-001` shows the full expected shape and is
marked `"example": true` until real recordings land. Each recorded clip is
hand-timed to ~10 ms precision (click-track count-in, pause-safe recording).

## Running

```sh
pnpm sync:measure
```

The report prints, per clip, the median word-onset error (ms) and word
coverage once `transcripts/<id>.cues.json` exists — before that it prints the
corpus overview and `0 clips transcribed`, which is the expected M00 state.

## Adding a clip

1. Record ~15 s of clean speech (16 kHz mono FLAC) into `audio/`.
2. Hand-time every word boundary; encode as `expectedCues[].words[]`.
3. Set `"recorded": true`.
4. Commit the audio, the JSON, and the hand-timing notes.
