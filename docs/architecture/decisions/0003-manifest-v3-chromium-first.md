---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0003 — Manifest V3, Chromium-first (Brave + Chromium target)

**Status:** accepted

## Context

The product targets Chromium and Brave first (user requirement), Firefox later. Modern Chrome extensions are **Manifest V3**: a service worker (short-lived, no DOM), off-main-thread, with strict permission model. Firefox now supports MV3. Any design must respect that the extension process is _not_ a place for long-running or heavy work — a constraint that shapes the whole architecture ([ADR-0004](0004-local-engine-outside-extension.md)).

## Decision

- Build for **Manifest V3** from day one.
- **Test continuously against both Chromium and Brave** (Playwright + manual matrix in Checkpoints; see [beta-1 checklist](../../checkpoints/Beta-1-Checklist.md)).
- Build with **WXT** so a Firefox build drops out later ([ADR-0015](0015-firefox-port.md)).
- Design the extension around MV3 realities:
  - Service worker: wake-on-event, stateless; engine calls happen there (fetch from the extension origin, not the page).
  - Content scripts: `all_frames: true` (video can live in an iframe); SPA navigation observed via history hooks + MutationObserver.
  - Storage: `chrome.storage.sync` for small prefs only; never blobs.
- **No MV2 fallback.** If a capability is genuinely missing in MV3 we design around it.

## Consequences

**Good:** future-proof (Google is retiring MV2), Firefox MV3 works via WXT, security model is strict by default.
**Cost:** service-worker lifetime limits interactions (keep state in `chrome.storage.session`, wake on `chrome.runtime.onMessage`); some older blogs suggest MV2 techniques we must ignore.

## Alternatives considered

- **MV2** — dead end; rejected.
- **Firefox-first** — user requirement is Chromium/Brave; Firefox deferred.

## Links

- [Spec 09 — Browser Extension](../../specification/09-Browser-Extension.md)
- [ADR-0004](0004-local-engine-outside-extension.md) · [ADR-0015](0015-firefox-port.md)
- [Checkpoints / Beta 1 test matrix](../../checkpoints/Beta-1-Checklist.md)
