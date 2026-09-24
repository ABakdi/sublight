# Contributing to sublight

Thanks for considering contributing. This is a solo project at the moment, but a
few simple conventions keep it coherent.

## Getting started

- Requirements: **Node.js ≥ 22**, **pnpm 9** (`corepack enable`).
- Install: `pnpm install`
- Build everything: `pnpm build`
- The docs vault in `docs/` is the source of truth for _why_ decisions exist
  (ADRs) and _what/how_ things should work (specifications). Read the
  [Home](docs/Home.md) page before touching architecture.

## Command reference

| Command              | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `pnpm dev:player`    | Vite dev server for the player app (`:5173`)                              |
| `pnpm dev:engine`    | Engine dev server (`:17421`, tsx watch)                                   |
| `pnpm dev:extension` | WXT dev mode (load `apps/extension/.output/chrome-mv3` in Chromium/Brave) |
| `pnpm lint`          | ESLint (flat config)                                                      |
| `pnpm lint:links`    | Docs link/anchor checker (must stay green)                                |
| `pnpm typecheck`     | `tsc --noEmit` across all workspaces                                      |
| `pnpm test`          | Vitest unit tests across all workspaces                                   |
| `pnpm e2e`           | Playwright (Chromium; Brave when installed)                               |
| `pnpm e2e:extension` | Extension e2e (builds the unpacked MV3 and loads it)                      |
| `pnpm sync:measure`  | Sync-accuracy corpus report                                               |

## Conventions

- **Commits**: conventional-commit style (`feat:`, `fix:`, `docs:`,
  `chore:`), small and self-contained.
- **Type-only imports**: use `import type` (enforced by ESLint).
- **Workspace boundaries** (see [ADR-0001](docs/architecture/decisions/0001-monorepo-layout.md)):
  `packages/core` is framework-free; `packages/overlay` only adds React; apps
  consume packages as workspace deps.
- **All cues/times** are integer milliseconds — no floats on the wire
  ([Spec 02](docs/specification/02-Data-Model.md)).

## Testing expectations

- Every PR must keep `pnpm lint`, `pnpm lint:links`, `pnpm typecheck`,
  `pnpm test`, and `pnpm build` green; CI enforces this.
- Docs changes must not break the link checker (`pnpm lint:links`).

## Docs

- [Home](docs/Home.md) · [Plan](docs/plan/README.md) · [Roadmap](docs/plan/Roadmap.md)
- Docs are an Obsidian vault; keep relative links and Mermaid diagrams valid.
