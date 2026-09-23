---
tags: [architecture, decision]
status: proposed
date: 2026-09-23
---

# ADR-0015 — Firefox port plan (proposed, not yet committed)

**Status:** proposed

## Context

Chromium + Brave ship first (user requirement). Firefox is a stated later target. The cost of porting is governed by how well the codebase avoided Chromium-specific APIs. WXT ([ADR-0002](0002-frontend-stack.md)) already emits Firefox add-ons; the remaining risk is **API surface**: `chrome.tabCapture` (audio capture is *core* to online captioning), MV3 differences, `all_frames` behaviors, and the `browser` namespace conventions.

## Decision (proposed)

- Port **after the Beta-1 checkpoint stabilizes** (target milestone **M08**), not in parallel.
- Use **`webextension-polyfill` / WXT's unified API** from day one (write against `browser.*`, emit Chrome wrappers) so the port is configuration, not archaeology.
- Game plan at M08:
  1. Add Firefox target in WXT; run Playwright's Firefox channel against the existing e2e suite.
  2. Audit the capture stack — `tabCapture` parity (Firefox: `browser.tabCapture.capture` with `video:false` support differs); fall back to same-origin capture + upload where it doesn't.
  3. Audit service-worker/idle semantics, storage quotas, and the token pairing flow.
  4. Language-specific Whisper quality on the Firefox-local test corpus (same models, so low risk).
- **No MV2 build** (ADR-0003).

## Consequences

**Good:** Chromium ships earlier; the port is low-risk because the surface is small and instrumented.
**Cost:** Firefox news *will* be in tab capture and possibly overlay scaling in fullscreen; acceptance criteria for M08 include "live captioning on YouTube in Firefox == Chrome parity".

## Open questions (to resolve during M08 planning)

- Does `tabCapture` audio-only in Firefox require a screen-share permission flow in a way that hurts UX? (If yes: consider same-origin capture + yt-dlp for Firefox v1.)
- Firefox `all_frames` + SPA detection parity on YouTube.

## Links

- [Plan M08 — Firefox](../../plan/milestones/08-Firefox.md)
- [ADR-0003](0003-manifest-v3-chromium-first.md)
- [Checkpoints](../../checkpoints/README.md)