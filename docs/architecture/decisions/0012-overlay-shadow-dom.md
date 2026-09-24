---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0012 — Subtitle overlay: Shadow DOM + shared React component + CSS-variable style schema

**Status:** accepted

## Context

The overlay must render identically in two very different hosts: the **player app** (React tree, we control everything) and **arbitrary third-party pages** via content script (aggressive CSS from the host page, `!important` rules, global selectors). It must survive page styles, not be readable/breakable by page scripts, and support fine user styling (color, background, size, font, placement).

## Decision

- The overlay lives in its **own Shadow DOM host** (closed or open shadow root; the host element is appended by the content script). Shadow DOM isolates us from the page's CSS; the page can't leak styles in, we can't leak styles out.
- The overlay is a **single React component in `packages/overlay`**, unmounted/mounted by the player directly and by the content script's injection host. One implementation, two mounts.
- Styling is driven by a **schema → CSS custom properties** mapping: user preferences (from `chrome.storage` / IndexedDB) become `--sl-cue-color`, `--sl-cue-bg`, `--sl-font-size`, `--sl-font-family`, … consumed by the overlay's own stylesheet. Changes re-render instantly; no class churn, no inline styles except the truly dynamic ones (position).
- Positioning: the host measures the play region (the `<video>` bounding box, or the player's video container), and the overlay is absolutely positioned over it with anchors: `bottom-center` (default), `top-center`, `top-left`, …, offset by user value, clamped to the viewport.
- Cue rendering avoids layout jumps (fixed line-height, pre-wrapped lines, no re-measure flicker) — see [Spec 05](../../specification/05-Overlay-Rendering.md).
- **Tailwind is not used inside the overlay** (framework styling in the shadow root is pointless and heavier); hand-written CSS with custom properties only.

## Consequences

**Good:** page-CSS immunity; exact consistency between player and extension; styling is data, so future themes (dark/light, high-contrast) are trivial configs; per-word (karaoke) highlighting and dual-language rendering are just more rendering modes of the same component ([Spec 05 §7](../../specification/05-Overlay-Rendering.md)).
**Cost:** we manage our own typography/positioning math; shadow-DOM event propagation needs care (capture key/click for edit mode); content-script sizing must re-observe the video on resize/fullscreen.

## Alternatives considered

- **Page-DOM overlay with inline styles + `!important`** — fragile against aggressive sites; rejected.
- **Injected `<style>` global selectors** — collision-prone; rejected.
- **CDP/Web Animations for positioning** — overkill; rejected.

## Links

- [Spec 05 — Overlay Rendering](../../specification/05-Overlay-Rendering.md)
- [ADR-0002](0002-frontend-stack.md) · [Spec 09 — extension overlay mount](../../specification/09-Browser-Extension.md)
