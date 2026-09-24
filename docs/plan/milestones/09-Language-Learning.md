---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M09 — Language-learning integration

**Goal:** sublight becomes a study surface for the sibling language-learning tool (a Language Reactor-style companion). The data model already anticipates this; this milestone wires the product-level UX.

## Scope

- **Dual-language study mode** (refined from M04's bilingual render): source line large, translation small/dim, word-by-word synchronization extends to _highlighting the currently-spoken word_ (karaoke) using word timestamps.
- **Click-a-word interactions**: tap a word → inline gloss/lemma (from a local dictionary, no cloud), pronunciation toggle (local TTS), save to a word list.
- **Shared library format**: a portable `.sublight.json` (project + tracks + styles) and a defined _library export_ (subtitles + word lists) that the sibling tool consumes; documented data contract in [Spec 02 §7](../../specification/02-Data-Model.md).
- Vocabulary export: CSV/Anki-friendly format of saved words (with source sentence + translation + timestamp link-back).
- Snippet save: capture a sentence pair + time range for future review.
- (Public roadmap) articulation with the sibling tool's own storage — decided in a new ADR at M09 planning ("language-learning bridge protocol").

## Tasks

- [ ] **M09.1** — Karaoke word-highlight render mode in `packages/overlay` (uses existing word timestamps; perf-tuned).
- [ ] **M09.2** — Click-word overlay: local dictionary lookup (lemmatizer) + inline popover, keyboard-first.
- [ ] **M09.3** — Local TTS pronunciation via engine (piper or similar open-source TTS — new model manifest entry, licensing per [ADR-0016](../../architecture/decisions/0016-model-licensing.md)).
- [ ] **M09.4** — Word list + snippet models in IndexedDB; vocab export (CSV/Anki).
- [ ] **M09.5** — `.sublight.json` library exchange contract with the sibling tool (double-checked against its schema at planning time).
- [ ] **M09.6** — Study-mode UI: side panel in player (and later extension), sentence pairs, review queue.
- [ ] **M09.7** — New ADR(s) for the bridge protocol; specs updated; checkpoint.

## Acceptance criteria

1. While watching, the current spoken word is highlighted in sync (≤ 100 ms of the word timestamp, verified on the corpus).
2. Clicking any word shows a gloss without leaving the video; saved words survive reloads.
3. Export produces an Anki-importable file with sentence + translation + link-back timestamps.
4. The sibling tool can open a `.sublight.json` library (contract validated on its side) — or we explicitly staged the contract for its next release (documented).

## Dependencies

- [M06](06-Beta-Release.md) maturity; [M07](07-Polish-Editing.md) editor base; word timestamps + bilingual rendering from M03/M04.
- ADR(s) to be created at M09 planning: bridge protocol, vocab schema, TTS model addition.

## Open questions

- Dictionary source (open-source dict DB — e.g. CC-CEDICT for Chinese, wiktextract style lemmas) — licensing check in [ADR-0016](../../architecture/decisions/0016-model-licensing.md) at planning time.
- TTS tradeoffs (piper = small & fast vs. higher quality per-language models) — benchmark on T1000.
- Whether the sibling tool is a separate app sharing the library file, or a mode inside sublight — **the owner decides at M09 planning**; the spec keeps both options open ([Spec 02 §7](../../specification/02-Data-Model.md)).

## Related

- [Spec 02 §7 — study-mode data](../../specification/02-Data-Model.md) · [Spec 05 §7 — karaoke/bilingual](../../specification/05-Overlay-Rendering.md)
- [ADR-0016](../../architecture/decisions/0016-model-licensing.md) (new models) · [Requirements F7](../../architecture/Requirements.md)
