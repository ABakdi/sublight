---
tags: [specification, asr, translation]
status: specified
updated: 2026-09-23
---

# 07 — ASR & translation pipelines

_The intelligence: how audio becomes word-synced cues, how sync stays perfect, and how translations come out fluent and aligned._

## 1. ASR pipeline

### 1.1 Input & normalization

Any audio → engine ffmpeg → **16 kHz mono PCM WAV**. Whisper's native input; nothing exotic.

### 1.2 Segmentation (whisper.cpp server output)

Segments with token-level timestamps:

```jsonc
{"segments":[{"start":0.0,"end":3.2,"text":"…","tokens":[{"text":" hello","t0":0.05,"t1":0.62}, …]}]}
```

### 1.3 Cue construction (shared with `core`)

`words → cues` rules ([02 §4](02-Data-Model.md#4-cue-construction--normalization)):

- Group into target 2–3 lines ≤ 42 chars; hard break at sentence-final punctuation and gaps ≥ 300 ms.
- Max cue 7 s → forced split at largest internal gap.
- Merge neighbors closer than 80 ms.
- Enforce ≥ 200 ms by extending `endMs`.

### 1.4 The sync equation

_The "perfect sync" core._

```
videoTime(cue) = audioStreamTime(cue) + T₀ + δ
```

| Symbol                 | Meaning                                                                         | Set by                                    |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `audioStreamTime(cue)` | whisper time on the captured/normalized audio                                   | ASR                                       |
| **T₀**                 | capture start anchor = `video.currentTime` at capture start (0 for local files) | capture layer ([08](08-Audio-Capture.md)) |
| **δ**                  | fine offset; estimated, then user-tweakable (±50 ms nudges)                     | auto + manual                             |

**(a) δ auto-estimation:** take the first ~10 s with speech (VAD); find speech onsets (energy rise) and match whisper word boundaries; δ = median(`onset − wordStart`). Cheap, robust, runs once per job. Fallback δ = 0 when no reliable onsets.

**(b) Drift control:** long captures re-anchor every ~2 min of strong speech: compute local δ per window, apply linear interpolation between anchors. This bounds total error < 500 ms on 2 h (target). Local files (T₀ = 0, audio = file audio exactly) need no drift correction.

**(c) Live mode:** while streaming, draft cues are anchored with the running δ estimate and pushed as `job.partial`; the user sees them within one window of latency.

### 1.5 Refinement pass (post-capture)

- Re-run ASR over the **full captured audio** with the user's chosen model (drafts used a fast/live model window).
- Re-anchor at control points (§1.4b); rebuild cues atomically; replace draft track in place (`draft:false`).
- Guard: if refinement's overall confidence or corpus metrics are worse than the draft's, keep the draft (never regress).

### 1.6 Long-form chunking

> 10 min audio → overlapping chunks (500 ms overlap, trimmed after merge), sequential (GPU is busy anyway) but resumable (chunk results persisted before next chunk).

### 1.7 Quality gates (measured, not assumed)

- Per-cue minimum word confidence warning (log only).
- Corpus harness ([M00.8](../plan/milestones/00-Foundations.md)) reports median word-onset offset + coverage; numbers published per release in [checkpoints](../checkpoints/README.md).

## 2. Translation pipeline (per [ADR-0009](../architecture/decisions/0009-translation-stack.md), amended by [ADR-0018](../architecture/decisions/0018-whisper-translate-to-english.md))

### 2.0 Choosing a translation path (ADR-0018)

There are two translators, picked per request:

| Target             | Audio available? | Glossary / register asked? | Path                                                                      |
| ------------------ | ---------------- | -------------------------- | ------------------------------------------------------------------------- |
| English            | yes              | no                         | **Whisper `translate`**: a transcribe job with `params.task: "translate"` |
| English            | yes              | yes                        | LLM (§2.1–2.6) over the source transcript                                 |
| English            | no (text track)  | —                          | LLM                                                                       |
| any other language | —                | —                          | LLM (installed on demand the first time)                                  |

**Whisper `translate` specifics:**

- Runs on the resident ASR model, so no model swap and no second download. Only multilingual checkpoints support it ([ADR-0007](../architecture/decisions/0007-whisper-model-matrix.md)); the engine returns `JOB_INVALID` for others.
- Word timestamps from a `translate` run are **not** used: the English words don't map to spoken source words. Cues are built from **segment** timestamps (split long segments at punctuation, proportional to character count), then go through the normal §1.3 rules (min duration, merge gap). `cue.words` is omitted on these tracks.
- The sync equation (§1.4) applies unchanged: segments are timed against the same audio, so T₀ and δ are shared with the source transcript.
- Resulting track: `kind: "translation"`, `language: "en"`, `derivedFrom: { sourceLanguage }` (no `trackId`: derived from audio). Bilingual source+English = two ASR passes over the same cached audio.

The rest of this section (§2.1–2.6) describes the **LLM path**.

### 2.1 Preprocessing: cues → paragraphs

1. Sentence-boundary detection (regex + punctuation + casing heuristics; keep abbreviation list).
2. Split cues on sentence boundaries **without breaking words** (cue may split into more cues — timing re-derived from word timestamps).
3. Group into paragraphs: consecutive units between **gaps ≥ 1.5 s** or cue-count 5–8; hard cap 1500 chars; never split a speaker turn.

### 2.2 Prompt (v1 template)

```
Translate the following subtitle lines to {targetLang} ({style} register).
Output ONLY numbered lines "{n}: {translated}" — no explanations, no
quotes, no extra text. Preserve [SPEAKER] tags and {special-form} markers.
Glossary: {glossary lines "source → target"}.
Lines:
1: …
2: …
```

Constraints: **numbered lines in**, numbered lines out → exact-count validation.

### 2.3 Validation & reconciliation

1. Parse output → expect `count == input count`:
   - **Match** → map 1:1 back to cues (timings untouched — translation inherits source timing exactly).
   - **Mismatch** → retry once with half the paragraph size; still mismatched → **proportional re-split**: distribute the output lines across the source cues by duration share, attach a `low-confidence` flag for the UI (rare; logged as a quality metric).
2. Glossary terms asserted present when source terms existed (soft check, logged).
3. Output sanitation: strip markdown/artifacts, enforce target script (spellcheck via simple script-range regex).

### 2.4 Jobs & concurrency

- A translate job walks paragraphs sequentially (GPU serialized), committing partial results per paragraph (`job.partial` with running track) so a 90-min film is resumable and visible in progress.
- **Bilingual data**: the overlay pairs source + translation tracks via `settings.bilingual` ([05 §7](05-Overlay-Rendering.md)); nothing in the data model blocks this ([02 §1](02-Data-Model.md)).

### 2.5 Prompt injection hygiene

Transcripts are **untrusted data** (audio may include instructions). Delimiters above + absolute output-format constraint + **never** echoing arbitrary source text back into system prompts beyond the delimited block; glossaries validated (no newlines). The [security audit](../audits/Security-Baseline-Plan.md) covers evasion cases.

### 2.6 Swappable translator

`TranslatorAdapter` interface: `translate(paragraphs, meta): Promise<ParagraphResult[]>` — implementations: `llamaLocal` (default), `nllbCtranslate2` (future), `mock` (tests). This keeps [ADR-0009](../architecture/decisions/0009-translation-stack.md)'s fallback path honest.

## 3. Language detection

- ASR auto-language (whisper) at job start → stored on the track as `track.language` (BCP-47 mapping table from whisper language codes).
- Translation target: user picks; English routes to Whisper `translate` when audio is available (§2.0), anything else to the LLM, validated against its language set with a friendly warning if unknown.

## 4. Related

- [Data model §4 — cue rules](02-Data-Model.md#4-cue-construction--normalization) · [Engine §6–7](06-Engine-Server.md) · [Audio capture](08-Audio-Capture.md)
- ADRs [0008](../architecture/decisions/0008-word-level-timestamps.md) · [0009](../architecture/decisions/0009-translation-stack.md) · [0018](../architecture/decisions/0018-whisper-translate-to-english.md)
- Milestones [M03](../plan/milestones/03-Transcription-Pipeline.md) · [M04](../plan/milestones/04-Translation-Pipeline.md)
