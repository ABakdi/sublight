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
pnpm dev:engine     # with whisper-small installed
pnpm sync:run       # transcribe every clip with audio through the engine
pnpm sync:measure   # the report
```

`sync:run` uploads each clip's audio (a repo path, or a `remote` URL pinned by
SHA-256 and cached in `~/.sublight/corpus-cache`, optionally trimmed), runs a
transcribe job and writes `transcripts/<id>.cues.json` (compact JSON, committed
as the measured snapshot). Options: `--model`, `--only <clipId>`.

### Two kinds of reference

- **Hand-timed words** (`expectedCues[].words`): the real ground truth. The
  en/fr/de/es/pt/ar clips are still waiting for recordings.
- **Energy onsets** (`"reference": { "method": "energy-onsets" }`): speech
  starts after ≥ 300 ms pauses, found by ffmpeg `silencedetect` relative to
  the clip's mean volume and saved as `transcripts/<id>.reference.json`. It
  checks only words that follow a pause, with a detector independent of the
  engine's own δ estimator. `en-jfk` and `de-kafka-30m` (30 min, for drift)
  use it.

The report prints median |onset error|, bias (signed median), coverage and
drift (shift of the median error between the first and last fifth of a clip).
Staging examples (`"example": true`) are shown but never counted.

M03 baseline, whisper-small: en-jfk 7 ms; de-kafka-30m 93 ms, bias −1 ms,
drift 0.5 ms, 99% of 540 onsets matched.

`pnpm seed:staging` still generates the synthetic staging transcript for the
`en-001` example.

The report prints, per clip, the median word-onset error (ms) and word
coverage once `transcripts/<id>.cues.json` exists — before that it prints the
corpus overview and `0 clips transcribed`, which is the expected M00 state.

`seed:staging` is a deterministic fixture generator: it seeds a fixed PRNG and
applies a fixed onset-offset pattern (plus occasional dropped short function
words) to every clip with word-level ground truth, so reruns are byte-identical
and the report shows _real numbers_ (a pass on F4 for the example clip). The
real engine ASR job (M03) will write these files from actual recordings.

## Adding a clip

1. Record ~15 s of clean speech (16 kHz mono FLAC) into `audio/`.
2. Hand-time every word boundary; encode as `expectedCues[].words[]`.
3. Set `"recorded": true`.
4. Commit the audio, the JSON, and the hand-timing notes.
