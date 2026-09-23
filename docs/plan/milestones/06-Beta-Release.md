---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M06 — Beta 1 release

**Goal:** a packaged, installable, *usable-by-a-non-dev* sublight. Pairing is smooth, the engine auto-starts, QA is methodical, and the **first checkpoint** is opened — the rest of the project learns from it.

## Scope

- Packaging: extension `.zip`/CRX loadable in Chromium + Brave; engine as a launchable binary (Node SEA or static bundle) with a one-click *start* flow; first-run setup walkthrough.
- Token pairing UX: paste-token in Options + `sublight://pair?token=…` custom-protocol handshake; rebind/rotate on demand.
- Engine autostart on login (Linux `systemd` user unit / Windows startup / macOS LaunchAgent — L1: plain instructions, L2: installer does it).
- Versioning & releases: semver, changelog, signed-ish artifacts, README/install docs.
- **Checkpoint Beta 1**: full test matrix (Chromium + Brave), sync corpus numbers published, bugs triaged, missing features routed (checkpoint template applies).
- First **[security baseline audit](../../audits/Security-Baseline-Plan.md)** run against the shipped artifact.
- Model install UI polish (disk budget display, eviction controls).

## Tasks

- [ ] **M06.1** — Extension packaged build loads in clean Chromium and Brave profiles (no "developer mode" hackery for the test user — document the tradeoff).
- [ ] **M06.2** — Engine packaging: single-launch binary/package; `sublight-engine start` + health URIs; graceful shutdown.
- [ ] **M06.3** — Pairing UX: token display, copy/paste field in Options, `sublight://` handshake, rotation; persisted in `chrome.storage.local` (per-profile).
- [ ] **M06.4** — Autostart instructions + installer integration (L1: docs; L2: actual setup).
- [ ] **M06.5** — Release pipeline: version bump, changelog, CI artifact build.
- [ ] **M06.6** — Checkpoint Beta-1 executed (template): test matrix rows checked on both browsers; corpus numbers; bugs triaged; missing features logged as issues that produce new spec/plan items.
- [ ] **M06.7** — Security baseline audit pass 1: findings recorded + fixes tracked ([audits](../../audits/README.md)).
- [ ] **M06.8** — Model store UI: installed size, remove models, disk budget warning.

## Acceptance criteria

1. A fresh (non-dev) profile can install the extension, start the engine, pair, and caption a YouTube video and a local file — **with no terminal**.
2. Pairing fails loudly and recoverably when the token is wrong/engine offline (no silent loops).
3. Checkpoint Beta-1 is opened with *every* matrix row filled; at least one real bug/underspecification found and routed.
4. The security baseline audit produced findings → fixes with owners or explicit `won't-fix` rationale.
5. Changelog + version tags exist and match the artifact.

## Dependencies

- [M04](04-Translation-Pipeline.md), [M05](05-Extension-Overlay.md) complete.
- ADRs: [0006](../../architecture/decisions/0006-engine-transport.md) (pairing), [0015](../../architecture/decisions/0015-firefox-port.md) (not yet), [0016](../../architecture/decisions/0016-model-licensing.md) (packaging legalities).

## Open questions

- Distribution channel for Beta 1 (local builds vs. a simple release page) — decide with the owner at M06 kickoff.
- Whether Node SEA/static engine is worth it vs. documented `pnpm install` (time-box: if packaging takes > 3 days, ship documented-requirements edition and mark L1 complete).

## Related

- [Checkpoint Beta 1](../../checkpoints/Beta-1-Checklist.md) · [Checkpoint template](../../checkpoints/Template.md)
- [Security baseline plan](../../audits/Security-Baseline-Plan.md) · [Roadmap](../Roadmap.md)