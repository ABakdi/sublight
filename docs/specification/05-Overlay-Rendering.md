---
tags: [specification, overlay]
status: specified
updated: 2026-09-23
---

# 05 — Overlay rendering

_How cues become pixels, identically in the player and inside arbitrary pages. One component in `packages/overlay`, mounted in two hosts._

## 1. Host & isolation (per [ADR-0012](../architecture/decisions/0012-overlay-shadow-dom.md))

- The overlay is a **Shadow DOM host** (`<sublight-overlay>` custom element with an open shadow root) appended to:
  - player: inside its video container;
  - extension: over the discovered `<video>` (content script).
- Inner root contains the React renderer + a scoped `<style>` derived from the active `SubtitleStyle` via **CSS custom properties** (`--sl-*`).
- The host element carries `data-sublight-host="true"` (dedupe marker — one overlay per video).

## 2. Scheduling

- Inputs: `SubtitleTrack` + a `positionSource` (`() => currentTime`, or the video element itself).
- A `requestAnimationFrame` loop (not timers) picks the active cue: last cue with `startMs ≤ t < endMs`. No cues → render nothing (zero layout cost).
- Position updates are layout-only (transform/translate), paint-cached; text changes only when the active cue id changes.

## 3. Geometry

- The host measures the play region each frame (cheap): the video's `getBoundingClientRect()` (extension) or the container rect (player), accounting for fullscreen and zoom.
- Overlay box: `position:absolute`, covers width; anchored per `style.position.anchor` + `marginPx`.
- **Font scaling**: `fontSize` is a baseline for a 720-px-tall video; scale factor = `containerHeight/720`, clamped [0.5, 2.5]. Ensures legibility at any window size.
- Margins clamp so cues never leave the viewport (a `ResizeObserver` on `document.body` catches outside-page resizes).

## 4. Text layout (no flicker)

- Pre-wrap by **word count** per `wrapStyle`/`maxLines` (default smart: fit widest word, balance lines).
- Fixed `lineHeight`, fixed reserved box (max 4 lines) so cue swap doesn't reflow the page underneath.
- Contrast: `textShadow`/`edgeStyle` applied in the scoped stylesheet; optional `bgColor`+`bgOpacity` box behind all lines (a single absolutely-positioned background div sized to content — measured once per cue, cached).
- `casing` and `align` transform text presentation only; the cue text itself is never mutated for display.

## 5. Style pipeline

```
storage (chrome.storage/IndexedDB) ──> SubtitleStyle (core) ──> CSS custom properties ──> scoped stylesheet
        user edit ──> same path (live)
```

Validated with `core.validateStyle`; invalid values fall back per-field to defaults. Style changes re-render without remounting the shadow root.

## 6. Draft vs final rendering

- `track.draft === true` → cues rendered with a subtle "⧗" watermark or 90% opacity + dashed underline affordance (user-configurable off), so live captions read as provisional.
- Atomic swap on refinement (same track id flips `draft:false` + cues replaced) never flickers.

## 7. Advanced render modes

- **Bilingual** (`settings.bilingual`, built in M04): `SubtitleOverlay` takes `secondaryCues` (+ `secondarySyncOffsetMs`); the source line renders above the translation in `.sl-secondary`: `--sl-secondary-color` (default `#d4d4d8`), `--sl-secondary-opacity` (0.85) and `--sl-secondary-scale` (0.75 × the main size), from `style.bilingual`. Each track is looked up on its own timing, so either line can show alone; bilingual mode lifts the `maxLines` clamp.
- **Sentences** (ADR-0020): the other display mode: one full sentence per cue ([02 §4](02-Data-Model.md)). Popup: Display → Show.
- **Word by word** (built 2026-09-26, default on in the Player and the extension): `revealByWords` expands each cue into steps whose text grows one word at a time, each step starting when its word is spoken, so captions appear exactly as the speech goes. Switch: the Player toolbar button toggles "Word by word" / "Sentences"; in the extension popup it is Display → Show.
- **Karaoke / word highlight (M09)**: when the active cue has `words`, highlight the word where `t` falls using `--sl-karaoke-color`; micro-offset `lagMs` to taste. Implemented as a per-word span overlay — same `SubtitleCue.text` source; cue timings untouched.
- **Speaker tags**: cues with `speaker` render `[Name]` prefix styled via `--sl-speaker-color` (text remains the real cue text).

## 8. Interactions

- Click-to-pause + select current cue (opens editor in the player; no-op in pages unless user enables "click to copy text").
- Hover affordance contains a small "copy cue" and "adjust sync ±" mini-controls in the player host; in third-party pages only a discreet cuetext copy on right-click menu is added (with an explicit opt-in).
- Keyboard in the player: `c` toggles captions, `ArrowUp/Down` micro-nudge offset (δ ±50 ms), `Alt+Left/Right` jump cue-by-cue.

## 9. Accessibility & performance budgets

- WCAG-contrast default (white on black-boxed, 4.5:1); user overrides allowed but a contrast warning appears for egregious combos.
- 60 fps steady-state: overlay costs < 1 ms/frame measured (shadow re-assembly only on cue change).
- Fullscreen entry re-measures (no stale rect); zoom (browser zoom) handled by `devicePixelRatio`-aware sizing.
- Reduced motion: karaoke highlight still fine; no animations introduced anyway.

## 10. Testing

- Unit: cue scheduler (time windows, boundaries, gap), layout math (anchors, scaling, clamping), style→CSS mapping.
- Visual: Playwright screenshots on fixture pages (YouTube fixture page + player fixture) asserting no overlap, no overflow, correct anchor.
- Both Chromium and Brave rows in the [Beta-1 checklist](../checkpoints/Beta-1-Checklist.md).

## 11. Related

- [02 — data model §6 style schema](02-Data-Model.md#6-style-schema) · [09 — extension mount](09-Browser-Extension.md)
- [ADR-0012](../architecture/decisions/0012-overlay-shadow-dom.md) · [M01](../plan/milestones/01-Player-Core.md) · [M09](../plan/milestones/09-Language-Learning.md)
