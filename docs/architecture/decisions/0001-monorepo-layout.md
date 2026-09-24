---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0001 — Monorepo, pnpm workspaces

**Status:** accepted

## Context

sublight has three runnable pieces (player app, Chromium extension, local engine) and several pieces that _must_ be shared without drift (subtitle data model, protocol types, the overlay React component). Without a shared package, the player and extension would each grow their own subtitle model and styling logic and slowly diverge. We also want type-checked, single-command builds and one CI pipeline.

## Decision

A single repository using **pnpm workspaces**:

```
sublight/
├─ apps/
│  ├─ player/        # React web player (Vite)
│  ├─ extension/     # Chromium MV3 extension (WXT)
│  └─ engine/        # Node local inference server (Hono)
├─ packages/
│  ├─ core/          # subtitle data model, formats (SRT/VTT/SSA), validation, pure TS
│  ├─ protocol/      # engine API types + message schemas (shared client/server)
│  └─ overlay/       # Shadow-DOM subtitle overlay component (React)
├─ docs/             # this vault
└─ e2e/              # Playwright cross-app tests (Chromium + Brave)
```

`packages/core` is **pure and framework-free** — it can run in the service worker, the content script, the player, and the engine. `packages/overlay` depends on `core` + React only. `apps/extension` reuses the overlay directly — one implementation of cue rendering everywhere.

## Consequences

**Good:** one `pnpm install`; shared types flow from engine ↔ clients with `tsc` proving the protocol end-to-end; the overlay component is tested once, used everywhere; CI covers everything in one pass.
**Cost:** monorepo tooling must be set up early (M00); workspace boundaries must be enforced by `tsconfig` paths + eslint config so `core` stays dependency-free.

## Alternatives considered

- **Polyrepo (3 repos + published npm packages)** — publishing overhead and version matrix for a solo project; rejected for coordination cost.
- **One flat folder, no workspaces** — simpler, but no enforced boundaries; rejected (drift risk is the core problem).

## Links

- [Plan M00 → scaffold monorepo](../../plan/milestones/00-Foundations.md)
- [Spec: package layout](../../specification/01-System-Overview.md)
