---
tags: [specification, data-model]
status: specified
updated: 2026-09-23
---

# 02 — Data model

_The nouns of sublight: projects, tracks, cues, words — plus their serialized forms and where they live. Authoritative for `packages/core`._

## 1. Core types (TypeScript, in `packages/core`)

```ts
/** One subtitle entry. All times are integer milliseconds. */
interface SubtitleCue {
  id: string // UUID
  startMs: number
  endMs: number
  text: string // may contain newlines = multiple rendered lines
  words?: SpeechWord[] // present when ASR produced word timestamps
  speaker?: string | null // from [SPEAKER] markers or future diarization
  lowConfidence?: boolean // translation re-split by duration, needs review (07 §2.3)
  style?: Partial<CueStyle> // per-cue overrides (rare)
}

/** Word-level atom from ASR/alignment. */
interface SpeechWord {
  word: string
  startMs: number
  endMs: number
  confidence?: number // 0..1
}

interface SubtitleTrack {
  id: string
  projectId: string
  language: string // BCP-47, e.g. "en", "pt-BR"
  title?: string // optional human label, e.g. "English (AI)"
  kind: 'transcript' | 'translation' | 'import'
  derivedFrom?: { trackId?: string; sourceLanguage: string } // for translations; no trackId when translated straight from audio (ADR-0018)
  draft?: boolean // true while live captions are replacing
  coverage?: { startMs: number; endMs: number }[] // drafts made ahead of playback: captioned ranges (ADR-0020)
  mediaDurationMs?: number // length of the media it was made from, when known
  cues: SubtitleCue[]
  style?: SubtitleStyle // track-level style (defaults to user global)
  syncOffsetMs?: number // whole-track nudge (δ or manual)
  createdAt: number // epoch ms
}

interface SubtitleProject {
  id: string
  title: string
  media: {
    kind: 'local-file' | 'page-video'
    source?: string // file name / page URL
    durationMs?: number
    mediaHash?: string // engine normalized-audio hash (transcription cache key)
    // --- page-video only (opened via "Open in Sublight Player", ADR-0017; see 04 §9) ---
    pageUrl?: string // origin page, retained for context/licensing
    pageTitle?: string // default project name source
    sources?: OpenInPlayerSource[] // as captured on the page (ordered preference)
    transport?: 'direct' | 'hls' | 'dash' | 'engine-relay' | 'none'
    directUrl?: string // effective playback URL (may be an engine relay URL)
    relayId?: string // engine media id when relayed (06 §4.1)
    resumeAtMs?: number // position migrated mid-play
  }
  tracks: SubtitleTrack[]
  settings: {
    activeTrackId?: string
    bilingual?: { sourceTrackId: string; translationTrackId: string } | null
    glossary?: { source: string; target: string }[] // fixed term translations (07 §2.2)
    style: SubtitleStyle // user-global style (player + extension share schema)
  }
  updatedAt: number
}
```

The `OpenInPlayerSource` list mirrors the extension's classifier ([09 §8.2](09-Browser-Extension.md#82-source-classification-content-script)):

```ts
type OpenInPlayerSourceKind =
  | 'https-direct' // plain media file → play directly
  | 'hls' // .m3u8 → hls.js
  | 'dash' // .mpd → dash.js
  | 'engine-fetchable' // blob:/MSE but site supported by the engine relay (yt-dlp)
  | 'blob-mse' // blob:/MSE, not transferable → cannot migrate
  | 'live' // video.isLive — playback only, transcription deferred (N7)

interface OpenInPlayerSource {
  kind: OpenInPlayerSourceKind
  url: string
  mime?: string
  quality?: string
  canPlayDirectly?: boolean
}
```

Resolution of those kinds into a playing track is spec'd in [04 §9](04-Player-App.md#9-opening-a-pages-video-open-in-player-adr-0017).

## 2. Invariants (validated by `core.validateProject`)

1. Cues sorted by `startMs`; no overlaps; `endMs > startMs`; duration ≥ 200 ms.
2. All times integers (rounding rule: `Math.round` to ms — export SRT uses `,mmm` anyway).
3. `words` (when present) must lie within their cue's `[startMs, endMs]` (clamped on construction).
4. A track is either `draft` or final — never both; refinement replaces the whole draft track atomically (same `track.id`, `draft` flips false, `cues` replaced).
5. Translation tracks keep `derivedFrom` so bilingual mode and glossary re-runs can find the source.

## 3. Format mapping

| Format               | Direction                     | Status   | Notes                                                                                                                                                                                                          |
| -------------------- | ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SRT**              | import + export               | v1       | `HH:MM:SS,mmm`; CRLF-tolerant on import; HTML tags stripped; `<i>` kept in export as `*…*`? → no, keep literal plain text (policy: subtitles we generate are plain; user-imported italics are preserved as-is) |
| **VTT**              | import (best-effort) + export | M07+     | cues with `00:00:00.000`; `WEBVTT` header                                                                                                                                                                      |
| **SSA/ASS**          | export later                  | deferred | styles map from schema; see [Data model open items]                                                                                                                                                            |
| **`.sublight.json`** | project export/import         | M06+     | full project (tracks+cues+styles+settings); also the **study-mode library exchange** format (M09)                                                                                                              |

SRT writer rules: time rounding, `-->` spacing (`-->`), blank line between cues, no trailing newline duplication, final newline present.

## 4. Cue construction & normalization

_Engine and editor share these rules._

From words → cues (ASR side):

- Group words greedily: target 2–3 lines of ≤ 42 chars each, or ≤ 7 s max cue; hard break at sentence-final punctuation (`.!?…`) and pauses ≥ 300 ms between words.
- ~~Merge cues closer than 80 ms~~ (removed 2026-09-26): continuous speech is always < 80 ms apart, so the merge undid the length split and produced 8–10 s cues. Merged fragment text is re-wrapped from the words, never truncated.
- **Reading hold**: each cue stays up max(1 s, 50 ms × characters) and lingers 0.5 s after its last word, never past the next cue's start; gaps < 80 ms close. Word timings are untouched.
- **Caption modes** (`cuesForMode`): `words`, where each cue grows word by word (`revealByWords`); or `sentences` (`cuesBySentence`), with one sentence per cue (split at `.?!…` or a 1.5 s pause), ≤ 2 lines and 7 s, and long sentences split at the clause break (`, ; : —`) nearest the middle. Both need word timings; tracks without them pass through. The overlay and the SRT export use the same modes.
- **Fragments** (≤ 2 words or < 800 ms) fold into a neighbour when the result still fits one cue: across the shorter pause (≤ 1 s), **never across a sentence end**. Read speech otherwise leaves one-word flashes ("Weitere", "Kafka") that also break line-by-line translation. Measured: 182 → 149 cues on 10 min of German, 3 left with ≤ 2 words.
- Minimum duration 200 ms enforced by stretching end (never move start past start).

From user edits (editor side): splitting a cue keeps `words` split at the word boundary; merging concatenates text with a space and unions words; every edit re-runs `normalizeCues()` then re-validation.

## 5. Storage layout

| Store                         | What                                                                                        | Key/granularity       | Owner                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------- |
| IndexedDB `sublight-projects` | projects store (`keyPath: id`), tracks store (`keyPath: id`, indexes `projectId`), settings | per-project docs      | Player                                        |
| `chrome.storage.sync`         | user prefs: style schema, default model, default language, glossary                         | flat keys, ≤ 8 KB     | Extension (+ player mirrors via prefs module) |
| `chrome.storage.session`      | transient: active job ids, last known engine state, draft cues                              | per-tab/per-extension | Extension                                     |
| `~/.sublight/config.json`     | token, ports, defaults, installed model ids                                                 | single file           | Engine                                        |
| `~/.sublight/jobs.jsonl`      | append-only job records (state transitions, results pointers, idempotency keys)             | per job               | Engine                                        |
| `~/.sublight/models/`         | model artifacts (pinned+checksummed)                                                        | per model id          | Engine                                        |
| `~/.sublight/media-cache/`    | normalized audio by `sha256`                                                                | per media hash        | Engine                                        |

Eviction: media-cache LRU, default cap 20 GB, configurable in Options/engine config. Projects are never auto-evicted (user data).

## 6. Style schema

_Shared by the overlay and both clients._

`SubtitleStyle` — serialized as a flat record of CSS custom-property values (see [05 — Overlay](05-Overlay-Rendering.md)):

```ts
interface SubtitleStyle {
  color: string // #RRGGBB
  bgColor: string // supports transparent via opacity
  bgOpacity: number // 0..1
  fontSize: number // px at reference video height 720, scaled with video
  fontFamily: string // css font stack
  fontWeight: number | 'normal' | 'bold'
  textShadow: boolean // adds outline for contrast
  edgeStyle: 'none' | 'outline' | 'shadow' | 'raised'
  align: 'left' | 'center' | 'right'
  position: {
    anchor:
      | 'bottom'
      | 'top'
      | 'left'
      | 'right'
      | 'bottom-left'
      | 'bottom-right'
      | 'top-left'
      | 'top-right'
    marginPx: number
  }
  maxLines: number // 1..4 (dictates pre-wrap)
  lineHeight: number // multiplier
  wrapStyle: 'smart' | 'word' // word = hard wrap by word count (default)
  opacity: number // 0..1 whole cue
  casing: 'normal' | 'uppercase' | 'title'
  // study mode (M09)
  karaoke?: { active: boolean; highlightColor: string; lagMs: number }
  bilingual?: { secondaryColor: string; secondaryOpacity: number; heightRatio: number }
}
```

Defaults live in `core` (`DEFAULT_SUBTITLE_STYLE`) so player ≠ extension ≠ engine can't diverge.

## 7. Study-mode data (planned, M09)

- `WordMemo { projectId, word, lemma?, translation, sourceCueId, sentence, savedAt, interval? }` — vocab list (IndexedDB).
- `Snippet { projectId, trackIds, startMs, endMs, note, savedAt }`.
- Library exchange: `.sublight.json` + optional wordlist payload; contract finalized in a new ADR at M09 planning ([milestone](../plan/milestones/09-Language-Learning.md)).

## 8. Open items

- BCP-47 strictness for track languages (allow "any" manual codes; validate format only).
- SSA/ASS export: decide mapping of edge styles → ASS layout tags (deferred; noted for [checkpoint](../checkpoints/README.md) if users ask).
- Per-cue style override for editor power users (schema supports it; UI in M07).

## 9. Related

- [05 — Overlay rendering](05-Overlay-Rendering.md) · [07 §1 — cue construction](07-ASR-And-Translation.md)
- [ADR-0014](../architecture/decisions/0014-storage.md) — why each store exists.
