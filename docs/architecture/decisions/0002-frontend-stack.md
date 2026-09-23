---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0002 — Frontend stack

**Status:** accepted

## Context

The player app and the extension UI both need a modern, typed, fast-fed React codebase. The tool should be bleeding-edge-but-stable: latest React and TypeScript as requested, fast dev loop, and a styling approach that doesn't fight the Shadow-DOM overlay.

## Decision

- **React 19** + **TypeScript 5.x** (strict) everywhere interactive.
- **Vite 7** for the player app; **WXT** for the extension (bundles the MV3 service worker, content scripts, popup/options pages, and cross-browser output — Chrome + Brave now, Firefox later per [ADR-0015](0015-firefox-port.md)).
- **Tailwind CSS 4** for *application chrome* (player UI, popup, options). The **subtitle overlay itself uses hand-written CSS** via the shared overlay package — no framework in the Shadow DOM (see ADR-0012).
- **Zustand** for app state (player, popup) — small, no boilerplate, works in React 19.
- **TanStack Query** for engine-client data fetching/caching in the player (jobs, models, status).
- **Vitest** for unit tests, **Playwright** (with Chromium and Brave binaries) for e2e.

## Consequences

**Good:** fast HMR; single language across the repo; WXT gives Firefox output for free later; Tailwind keeps UI iteration quick; overlay stays framework-styling-free where it matters.
**Cost:** WXT is younger than raw manifest tooling — pin versions; Tailwind v4 config differs from v3 (CSS-first, `@theme`) — recorded in M00 scaffolding tasks.

## Alternatives considered

- **Next.js for the player** — no SSR need; a local-file player is a pure client app; rejected (Vite is leaner).
- **Inline CSS-in-JS for the overlay** — evaluated and rejected: runtime style injection into the Shadow DOM is slower and harder to read than plain CSS custom properties ([ADR-0012](0012-overlay-shadow-dom.md)).

## Links

- [Spec 04 — Player App](../../specification/04-Player-App.md)
- [Spec 09 — Browser Extension](../../specification/09-Browser-Extension.md)
- [Plan M00](../../plan/milestones/00-Foundations.md)