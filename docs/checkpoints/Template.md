---
tags: [checkpoints, template]
status: open
updated: 2026-09-23
---

# Checkpoint — {Release name}

<!-- Copy this file to a new checkpoint file. Fill EXPECTED before testing, ACTUAL during. -->

- **Release:** {semver / beta n}
- **Opened:** {date} · **Closed:** {date}
- **Status:** `open` / `in-triage` / `closed`
- **Milestone(s) covered:** {M0n…}

## 1. Environment

- Engine version + commit: { }
- Extension version + commit: { } · Player: { }
- Models (asr / translate): { } · Browsers: Chromium {ver} · Brave {ver} · (Firefox {ver} at M08+)
- Hardware: {target machine or other — note deviations}

## 2. Test matrix (fill EXPECTED pre-release, ACTUAL per row)

| #   | Flow                                                            | Browsers | EXPECTED | ACTUAL | Pass/fail |
| --- | --------------------------------------------------------------- | -------- | -------- | ------ | --------- |
| T1  | YouTube — live captions appear ≤ 8 s behind speech              | Ch, Br   | —        |        |           |
| T2  | YouTube — refinement replaces drafts, timing < 250 ms           | Ch, Br   | —        |        |           |
| T3  | YouTube — seek/pause/speed during capture                       | Ch, Br   | —        |        |           |
| T4  | YouTube — SPA navigation to a new video                         | Ch, Br   | —        |        |           |
| T5  | Vimeo — same-origin capture path                                | Ch, Br   | —        |        |           |
| T6  | Generic `<video>` page + iframe player                          | Ch, Br   | —        |        |           |
| T7  | Local file captioning (player) end-to-end                       | Ch, Br   | —        |        |           |
| T8  | Translation to {EN, AR, JA …} — meaning spot-check              | Ch, Br   | —        |        |           |
| T9  | Bilingual track rendering                                       | Ch, Br   | —        |        |           |
| T10 | Style changes apply live + persist                              | Ch, Br   | —        |        |           |
| T11 | SRT export imports cleanly back                                 | Ch, Br   | —        |        |           |
| T12 | Engine offline → graceful degrade                               | Ch, Br   | —        |        |           |
| T13 | DRM/mute/autoplay-block error surfaces                          | Ch, Br   | —        |        |           |
| T14 | Sync corpus numbers (median onset < 250 ms; drift < 500 ms/2 h) | —        | —        |        |           |

## 3. Performance numbers (actual)

- ASR realtime-factor on target hardware: { }×
- Translation throughput: { } tok/s, { } s per paragraph
- Live caption latency (T1): { } s
- Memory: engine { } MB · player { } MB · banner tab { } MB

## 4. Bugs found

| ID  | Severity (P0/P1/P2) | Summary | Repro | Root cause (if known) | Disposition                               |
| --- | ------------------- | ------- | ----- | --------------------- | ----------------------------------------- |
| B1  |                     |         |       |                       | fix-now / deferred(when) / won't-fix(why) |

## 5. Missing features / forgotten work

| ID  | What we forgot or never specified | Where it should live           | Decision                                    |
| --- | --------------------------------- | ------------------------------ | ------------------------------------------- |
| M1  |                                   | spec section / plan task / ADR | accepted / defer / out-of-scope(→Non-goals) |

## 6. Underspecified items (spec gaps found while testing)

| ID  | Spec area | Gap | Fix         |
| --- | --------- | --- | ----------- |
| U1  |           |     | edit + link |

## 7. Things we believed would work that didn't

_Surprises land here: things we believed would work that didn't._

1. { }

## 8. Triage summary & actions

- Fix-now items → task list: { }
- Deferred backlog: { }
- New audits triggered: { }
- Specs changed: { }
- ADRs created/updated: { }

## 9. Sign-off

- Owner date:
- "Closed" only when every row in §4–§7 has a disposition.
