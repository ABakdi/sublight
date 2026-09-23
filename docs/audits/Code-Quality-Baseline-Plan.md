---
tags: [audits, code-quality]
status: planned
updated: 2026-09-23
---

# Code quality baseline plan

_Quality gates that must hold from **M02 onward**, plus a periodic structural audit. The plan defines the floor; results get recorded per audit run._

## The floor (enforced by CI from M02)

| Gate | Rule | Feedback time |
|---|---|---|
| TypeScript | `strict: true` everywhere; no `any` in `packages/`; protocol types shared not duplicated ([ADR-0001](../architecture/decisions/0001-monorepo-layout.md)) | per commit |
| Lint | ESLint flat config (recommended + react + ts) ; Prettier formatting | per commit |
| Tests | `pnpm test` green; `core` ≥ 90% coverage; overlay ≥ 80%; engine job/queue ≥ 85% | per PR |
| Build | All workspaces build; extension bundles; engine boots | per PR |
| e2e | Playwright smoke on Chromium + Brave for the flows of the current milestone | per PR (smoke), nightly (full) |
| Deps | `pnpm audit` zero high/critical; lockfile diff reviewed | per PR + nightly |

## Structural audit checklist (run at M02 end, M04/M05 boundary, M07, then pre-release)

- [ ] **No cross-package leaks**: `core` is framework-free; `overlay` only imports core+react; no app imports from sibling apps.
- [ ] **Protocol drift impossible**: server + client types compile against the same `packages/protocol` (a CI job asserts tsc references).
- [ ] **Error handling**: every engine worker error path has a typed, retryable/non-retryable classification ([Protocol §4](../specification/03-Protocol.md#5-job-lifecycle--states)); no swallowed errors; `noUncheckedIndexedAccess` respected.
- [ ] **Async hygiene**: no floating promises; cancellation propagates; WS reconnect backoff capped.
- [ ] **State discipline**: player state via Zustand stores only; no `useState`-flinging of project data across routes; IndexedDB writes batched.
- [ ] **Dead code / TODOs**: TODO count under threshold; no commented-out blocks; unused exports flagged (knip or eslint no-unused working).
- [ ] **Performance**: overlay rAF costs < 1 ms/frame ([05 §9](../specification/05-Overlay-Rendering.md)); no unbounded listener growth in content scripts (leak probe: navigate 100×, heap stable).
- [ ] **Dependencies**: `pnpm outdated` triage log; model manifest pins reviewed against [ADR-0016](../architecture/decisions/0016-model-licensing.md).
- [ ] **Docs-vs-code truth**: spec statuses (`implemented/planned`) match reality — the audit checks at least 3 random spec claims per run.

## How findings flow

- Findings table per run ([Template](Template.md)); dispositions link to tasks or ADRs.
- Enforcement is the point: if a gate is broken, the audit closes with "gate X re-enabled" as its first fix.

## First runs (planned)

| Run | When | Trigger |
|---|---|---|
| Q-1 | End of [M02](../plan/milestones/02-Local-ASR-Engine.md) | Engine is the risky core; gate soundness matters before clients lean on it |
| Q-2 | [M04/M05](../plan/milestones/04-Translation-Pipeline.md) boundary | Two client surfaces join; drift risk peaks |
| Q-3 | Pre-[M06](../plan/milestones/06-Beta-Release.md) | Release gate full pass |
| Q-4 | [M07](../plan/milestones/07-Polish-Editing.md) end | Post-Beta hardening |

## Related

- [Audits index](README.md) · [Checkpoints](../checkpoints/README.md) · [M00 toolchain tasks](../plan/milestones/00-Foundations.md)