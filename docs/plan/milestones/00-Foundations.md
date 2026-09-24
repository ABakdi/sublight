---
tags: [plan, milestone]
status: in-progress
updated: 2026-09-23
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

- [ ] **M00.1** — pnpm workspace: `apps/{player,extension,engine}`, `packages/{core,overlay,protocol}`; `tsconfig` base with strict mode; path aliases.
- [ ] **M00.2** — Vite React app (player) boots with a placeholder page; Vitest config; one unit test.
- [ ] **M00.3** — WXT extension scaffold (MV3) loads unpacked in Chromium and Brave; content script logs on a test page.
- [ ] **M00.4** — Engine skeleton (Hono): `/v1/health` returns `{status:"online"}`; token auth middleware stubbed.
- [ ] **M00.5** — ESLint/Prettier configs shared; `pnpm lint` green; git hooks (husky + lint-staged).
- [ ] **M00.6** — CI pipeline runs the above on every PR.
- [ ] **M00.7** — Playwright launches **Chromium and Brave** (executablePath for Brave) against the player placeholder; example spec committed.
- [ ] **M00.8** — Sync corpus: recordings + `corpus.json` (id, language, src audio, expected cues with word times); metric script `ts-node`/Vitest that reports median onset offset.
- [ ] **M00.9** — Docs vault finalized: Home, architecture, plan, specification, checkpoints, audits all linked; README TOC accurate.
- [ ] **M00.10** — `.gitignore`, LICENSE file, CONTRIBUTING stub, editor configs.

## Acceptance criteria

1. `pnpm install && pnpm build` succeeds for all workspaces on a clean checkout.
2. CI is green on a trivial PR.
3. Playwright spec passes on both Chromium and Brave.
4. Sync-corpus harness runs and prints a numeric report (even if the number is "no ASR yet").
5. Every docs area renders linked from [Home](../../Home.md); no broken links in the vault (a link-check script task added to M00.9).

## Dependencies

None (this is the base). Everything downstream assumes M00's structure ([Roadmap](../Roadmap.md)).

## Open questions

- Brave binary path on this dev box (CI uses bundled Chromium; Brave for local/interactive runs).
- Whether to add Turborepo now or keep plain `pnpm -r` for v1 (plain is fine; add later if builds slow).

## Related

- ADRs: [0001](../../architecture/decisions/0001-monorepo-layout.md), [0002](../../architecture/decisions/0002-frontend-stack.md), [0003](../../architecture/decisions/0003-manifest-v3-chromium-first.md)
- Specs to stub first: [01 System overview](../../specification/01-System-Overview.md), [02 Data model](../../specification/02-Data-Model.md), [03 Protocol](../../specification/03-Protocol.md)
