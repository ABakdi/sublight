---
tags: [audits, index]
status: active
updated: 2026-09-23
---

# Audits

_Every now and then we do a security, code, or quality audit and record it here — findings, fixes, and follow-ups. Audits are periodic deep-checks that cut across milestones; checkpoints catch day-to-day bugs, audits catch structural rot._

## Audit types

| Type | Focus | Cadence (target) |
|---|---|---|
| **Security** | Attack surface: localhost auth, injection, supply chain, extension permissions, data privacy | At M06 (Beta 1), then each major release |
| **Code quality** | Structure, dead code, error handling, type safety, test health | At M02, M04/M05 boundaries, M07 |
| **Performance** | Memory, latency budgets, GPU scheduling, long-video behavior | At M06, M07 |
| **Dependency & license** | `pnpm audit`, outdated pins, model/license manifest drift | Quarterly + before releases |
| **Privacy** | "Nothing leaves the machine" claim re-verified end-to-end | At M06, then annually |

## Process

1. **Open an audit** (copy [Template.md](Template.md)) with scope + pass criteria.
2. **Run it** — record findings with severity and evidence.
3. **Fix or defer** — each finding gets a disposition: fixed / scheduled (owner + milestone) / won't-fix (rationale).
4. **Close** — findings summary + what the release gate learned from it.
5. Findings that change the design → **new ADR** (that's the rule: [architecture](../architecture/README.md)).

## Index

| Audit | Type | Status | Opened | Summary |
|---|---|---|---|---|
| [Security baseline plan](Security-Baseline-Plan.md) | Security | `planned` (run at [M06](../plan/milestones/06-Beta-Release.md)) | — | First full pass over the engine boundary, extension permissions, prompt injection, model supply chain, privacy claim. |
| [Code quality baseline plan](Code-Quality-Baseline-Plan.md) | Code quality | `planned` | — | Gates to enforce from M02: lint/typecheck, test coverage floors, error-handling review, dependency hygiene. |

> The two plans above are **criteria, not results** — they're the checklist the first audits will execute. Results get recorded under this index as the audits run.

## Where the teeth are

- Security rules **must not regress silently**: the [security baseline](Security-Baseline-Plan.md) pass criteria are wired into the release gate ([Definition of done](../plan/Roadmap.md#definition-of-done-for-a-release-beta-1-and-later)) and the [checkpoint template](../checkpoints/Template.md#7-things-we-believed-would-work-that-didnt).
- Every finding's disposition links to a task, spec, or ADR — an audit that doesn't produce work is a review that didn't find anything (fine sometimes, but rare).

## Related

- [Checkpoints](../checkpoints/README.md) — the faster feedback loop audits complement.
- [Spec 10 — failure modes](../specification/10-Non-Goals-And-Failure-Modes.md) · [Architecture decisions](../architecture/Decisions.md)