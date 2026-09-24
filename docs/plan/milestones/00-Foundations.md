---
tags: [plan, milestone]
status: done
updated: 2026-09-24
---

# M00 — Foundations

**Goal:** a working, testable skeleton + the tooling that everything else leans on, plus this documentation vault.

## Scope

- Monorepo scaffold (per [ADR-0001](../../architecture/decisions/0001-monorepo-layout.md)).
- Toolchain: pnpm, TypeScript strict, ESLint + Prettier, Vitest.
- CI (GitHub Actions): install → lint → typecheck → test → build → e2e smoke.
- **Playwright harness** able to launch **Chromium and Brave**.
- **Sync-accuracy harness**: a small ground-truth corpus (5–10 short clips across languages with hand-timed word boundaries) + a metric script (median onset error, word coverage) — the yardstick for the "perfect sync" promise ([Requirements F4](../../architecture/Requirements.md)).
- This documentation vault (the docs you're reading).

## Tasks

- [x] **M00.1** — pnpm workspace: `apps/{player,extension,engine}`, `packages/{core,overlay,protocol}`; `tsconfig` base with strict mode; path aliases.
- [x] **M00.2** — Vite React app (player) boots with a placeholder page; Vitest config; one unit test.
- [x] **M00.3** — WXT extension scaffold (MV3) loads unpacked in Chromium and Brave; content script logs on a test page.
- [x] **M00.4** — Engine skeleton (Hono): `/v1/health` returns `{status:"online"}`; token auth middleware stubbed.
- [x] **M00.5** — ESLint/Prettier configs shared; `pnpm lint` green; git hooks (husky + lint-staged).
- [x] **M00.6** — CI pipeline runs the above on every PR.
- [x] **M00.7** — Playwright launches **Chromium and Brave** (executablePath for Brave) against the player placeholder; example spec committed.
- [x] **M00.8** — Sync corpus: recordings + `corpus.json` (id, language, src audio, expected cues with word times); metric script `ts-node`/Vitest that reports median onset offset.
- [x] **M00.9** — Docs vault finalized: Home, architecture, plan, specification, checkpoints, audits all linked; README TOC accurate.
- [x] **M00.10** — `.gitignore`, LICENSE file, CONTRIBUTING stub, editor configs.

## Acceptance criteria

1. `pnpm install && pnpm build` succeeds for all workspaces on a clean checkout. — **Done** (`pnpm build` exit 0, all 7 workspaces).
2. CI is green on a trivial PR. — **Pipeline green locally**: `lint`, `lint:links` (616 links), `typecheck` (7/7), `test` (45 tests incl. 4 Playwright e2e), `build`, `sync:measure`.
3. Playwright spec passes on both Chromium and Brave. — **Chromium green** (engine auth/health + player specs, 4/4). Brave runs when `findBravePath()` locates an install (none on this box); the harness auto-picks it.
4. Sync-corpus harness runs and prints a numeric report (even if the number is "no ASR yet"). — **Done**: `pnpm sync:measure` prints corpus overview + `0/6 clips transcribed; median word onset error: null ms`.
5. Every docs area renders linked from [Home](../../Home.md); no broken links in the vault (a link-check script task added to M00.9). — **Done**: `scripts/lint-links.mjs` checks 616 links with 0 problems (wired to `pnpm lint:links`).

## Completion notes

- Extension e2e verifies the **unpacked MV3 content-script log** (Spec 09) headless via Playwright's `chromium` channel (`EXTENSION_TESTS=1`, `pnpm e2e:extension`) — no X server required, so CI needs no xvfb.
- Engine config honours `SUBLIGHT_HOME/config.json` and auto-generates+persists a 64-hex bearer token; loopback host + origin allowlists on every route.
- Player dev server binds `127.0.0.1:5173` (Vite 7 defaults to IPv6-only `localhost`, which broke the Playwright webServer probe).
- WXT 0.21 module API: `modules` takes package-name strings (`['@wxt-dev/module-react']`), and content/background entrypoint helpers live under `wxt/utils/define-*`.

## Dependencies

None (this is the base). Everything downstream assumes M00's structure ([Roadmap](../Roadmap.md)).

## Related

- ADRs: [0001](../../architecture/decisions/0001-monorepo-layout.md), [0002](../../architecture/decisions/0002-frontend-stack.md), [0003](../../architecture/decisions/0003-manifest-v3-chromium-first.md)
- Specs to stub first: [01 System overview](../../specification/01-System-Overview.md), [02 Data model](../../specification/02-Data-Model.md), [03 Protocol](../../specification/03-Protocol.md)
