---
tags: [plan, milestone]
status: not-started
updated: 2026-09-23
---

# M08 — Firefox port

**Goal:** sublight works in Firefox with **parity on the core journey** (live captioning on YouTube + local-file captioning), per [ADR-0015](../../architecture/decisions/0015-firefox-port.md).

## Scope

- WXT Firefox target + `webextension-polyfill`-style unified API usage (from M00/M05 onward the code is written `browser.*`-first; this milestone makes it real).
- **Capture parity** — the risky bit ([ADR-0010](../../architecture/decisions/0010-audio-capture-strategy.md)): `tabCapture` differences; decide per findings whether Firefox v1 uses same-origin capture + upload/yt-dlp for the online path.
- Overlay / fullscreen / SPA parity checks on the site matrix.
- Firefox-specific test matrix row in every [checkpoint](../../checkpoints/README.md) from here on.
- Ship both browser artifacts from one build; update packaging docs.

## Tasks

- [ ] **M08.1** — WXT Firefox target builds; extension loads in Firefox Nightly + stable.
- [ ] **M08.2** — Audit every Chrome-only API call (`tabCapture`, `chrome.storage.session`, scripting, `runtime.onInstalled` details); replace/polyfill.
- [ ] **M08.3** — Capture strategy decision doc for Firefox (results → update ADR-0015 to `accepted`).
- [ ] **M08.4** — Site matrix run in Firefox (YouTube, Vimeo, iframe players, local player path).
- [ ] **M08.5** — Sync-corpus + translation QA spot-check in Firefox (models are identical — expect no delta; verify anyway).
- [ ] **M08.6** — Firefox row added to checkpoint template; Beta-level checkpoint opened for M08.

## Acceptance criteria

1. YouTube live captioning works in Firefox with ≤ 2 s extra latency vs. Chrome (or an accepted, documented difference).
2. Local-file journey (player + engine) works in Firefox identically.
3. All e2e specs in CI run on a Firefox channel (Playwright) alongside Chromium/Brave.
4. No Chrome-only API remains outside the documented compat layer.

## Dependencies

- [M06](06-Beta-Release.md) (stability first), [M07](07-Polish-Editing.md).
- ADR: [0015](../../architecture/decisions/0015-firefox-port.md) — promoted to `accepted` on completion.

## Open questions

- Firefox `tabCapture` audio-only behavior (permission UI shape) — the single biggest unknown; resolved early in M08.3 and fed back into the ADR.
- Add-on review requirements (if publicly distributed) — licensing/sharing checklist imported from [ADR-0016](../../architecture/decisions/0016-model-licensing.md).

## Related

- [ADR-0015](../../architecture/decisions/0015-firefox-port.md) · [Spec 09 — Browser Extension](../../specification/09-Browser-Extension.md) · [Spec 08 — Audio Capture](../../specification/08-Audio-Capture.md)