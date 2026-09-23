---
tags: [checkpoints, beta]
status: open
updated: 2026-09-23
---

# Checkpoint — Beta 1 (planned)

> Executed at **[M06 — Beta release](../plan/milestones/06-Beta-Release.md)**. This file is the pre-filled template for that checkpoint: **expected** values are decided now so "good" is defined before we test. The checkpoint is `open` until the matrix is run and triaged.

- **Release:** Beta 1 (M06)
- **Opened:** at M06 · **Status:** `open` (planned)
- **Milestone(s) covered:** M00–M06 (+ [M05b](../plan/milestones/05b-Open-in-Player.md), only if it lands in time — non-blocking)

## What Beta 1 must prove

1. A non-dev can install, pair, and caption a YouTube video **and** a local file without a terminal.
2. Live captions are good enough to watch with; refined cues hit the sync budget.
3. Translation is meaning-accurate on the primary language pairs.
4. Graceful degradation everywhere (engine down, DRM, muted tab…).

## Pre-decided expected values (the "good" bar)

| Metric | Expected bar | Measured |
|---|---|---|
| Live caption latency | ≤ 8 s behind speech (T1000, base/small) | |
| Median word-onset offset (corpus) | ≤ 250 ms | |
| Cumulative drift, 2 h capture | ≤ 500 ms | |
| Translation meaning QA | ≥ 90% paragraphs pass (3 pairs × 10) | |
| SRT round-trip | byte-stable (fixtures) | |
| Memory during caption job | engine ≤ 3 GB · player ≤ 1.5 GB | |
| e2e smoke (both browsers) | 100% green | |

## Matrix (rows pre-filled from the template; run at M06)

| # | Flow | Ch | Br | Notes |
|---|---|---|---|---|
| T1 | YouTube live captions | | | tabCapture path (YouTube is EME → captureStream muted) |
| T2 | YouTube refinement + timing | | | corpus cross-check |
| T3 | Seek / pause / speed mid-capture | | | re-anchor behavior |
| T4 | SPA navigation YouTube→new video | | | |
| T5 | Vimeo | | | likely captureStream-clean path |
| T6 | Generic page + iframe player | | | |
| T7 | Local file captioning | | | player + engine |
| T8 | Translation EN→DE/AR/JA spot check | | | |
| T9 | Bilingual render | | | |
| T10 | Style live + persist | | | |
| T11 | SRT export → re-import | | | |
| T12 | Engine offline state | | | cards + retry, no crash |
| T13 | DRM / mute / autoplay-block errors | | | no silent failure |
| T14 | Corpus + perf numbers | | | publish in §3 |
| T15 | Open in Sublight Player — direct `.mp4` + engine relay fixture | | | *only if M05b lands in Beta 1 (non-blocking); else carried to Beta 2. Resume + failure paths included. |

## Known gaps to watch (candidates before we even start)

- yt-dlp toggle may be rough on YouTube after signature changes — treat as an optional extra, not a Beta-1 blocker.
- First-run model download UX (network needed, can be slow) — flag if > 3 min without feedback.
- Firefox parity — NOT in Beta 1 (that's M08).
- Editor polish — deliberately minimal at Beta 1 (M07 ships it); only text-fix in popup.

## Triage routing reminder (from [README](README.md))

- Bugs → milestone tasks with severity.
- Mis-features → spec + plan.
- Security/quality → audits.

## Sign-off

- Owner date: — (pending M06 execution)