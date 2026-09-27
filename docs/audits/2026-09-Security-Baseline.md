---
tags: [audits, security]
status: closed
updated: 2026-09-27
---

# Audit — Security baseline, pass 1 (Beta 1)

- **Type:** security
- **Opened:** 2026-09-27 · **Closed:** 2026-09-27
- **Status:** `closed`
- **Trigger:** release gate ([M06.7](../plan/milestones/06-Beta-Release.md))

## 1. Scope

- In: the engine (HTTP, WS, relay, pairing, the served Player, worker servers, subprocesses), the extension (service worker, content scripts, permissions), the Player's hand-over, translation prompts, model and binary supply chain, the privacy claim.
- Out: the browsers themselves, the OS, other users' malware running as the same user (it can read `config.json` anyway), the Firefox port.

## 2. Pass criteria

The checklist in the [security baseline plan](Security-Baseline-Plan.md) (sections A–G).

## 3. Evidence gathered

- Three code reviews (engine boundary; extension and pairing; privacy, prompts and supply chain), each criterion with file:line evidence.
- Dynamic checks against the bundled engine (`sublight-engine start --detach`, temp home):
  - `ss -tlnp`: only `127.0.0.1:<port>` and the Player port listen.
  - `Host: evil.com`, `Host: 127.0.0.1.evil.com` and a missing Host give 403/403/400.
  - `Origin: https://evil.com` and `Origin: null` give 403.
  - A preflight from an evil origin gets no CORS headers.
  - Every data route without a token gives 401; errors are JSON.
  - An unauthenticated WebSocket is closed with 4401 after 1.02 s.
  - `config.json` is 0600, and the token appears in no log.
- whisper-server probed directly: `Access-Control-Allow-Origin: *`, and with `--request-path` every endpoint (`/health`, `/inference`, `/load`) moves under the prefix.
- `pnpm audit --prod`: no known vulnerabilities.
- Worker binaries: whisper v1.9.4, llama b11174 and yt-dlp 2026.08.19 match their recorded SHA-256.
- Environment: engine 0.1.0 · extension 0.1.0 · whisper-small, Qwen3-4B Q4_K_M · Brave (e2e), Linux.

## 4. Findings

| ID  | Severity | Area              | Finding                                                                                                                                                        | Disposition                                                                                                                                                                 |
| --- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P2       | Relay (A5)        | The unauthenticated relay passed the upstream `content-type` through: a hostile host could render HTML on the engine's origin, the one that approves pairings. | fixed: non-media types go out as `application/octet-stream` with `CSP: sandbox`                                                                                             |
| F2  | P2       | Workers (A1)      | whisper-server and llama-server have no auth and answer any origin: any web page could run inference or make whisper `/load` a file.                           | fixed: a new secret per spawn (whisper `--request-path` prefix, llama `--api-key-file`)                                                                                     |
| F3  | P2       | Extension (B4)    | The SW took popup requests from content scripts, and `captions.next` let a page start url jobs (engine fetches with the viewer's cookies) at any URL.          | fixed: extension-page-only requests; `captions.next` only for followed tabs, same site ([ADR-0024](../architecture/decisions/0024-web-supplied-urls-and-handoffs.md))       |
| F4  | P2       | Player (F6)       | Any site could open the Player with a `#sl=` payload that made the engine resolve and download a URL of its choosing.                                          | fixed: "Open this video?" confirmation; user agent validated                                                                                                                |
| F5  | P2       | Engine (A10)      | Page-supplied URLs could point at loopback or the local network (SSRF), and the result was relayed.                                                            | fixed: public addresses only, `allowPrivateNetworks` to opt in                                                                                                              |
| F6  | P2       | Subprocesses (A8) | ffmpeg had no protocol whitelist for remote manifests (a playlist could name `file:` segments).                                                                | fixed: `-protocol_whitelist http,https,tls,tcp,crypto,data,httpproxy`                                                                                                       |
| F7  | P2       | Engine (A6)       | `POST /v1/live/:id/audio` and every JSON route read the whole body before checking size.                                                                       | fixed: body limits before reading (`BODY_TOO_LARGE`)                                                                                                                        |
| F8  | P2       | Relay (DoS)       | yt-dlp downloads and ffmpeg remuxes were unbounded in number, time and size.                                                                                   | fixed: 2 at once, 45 min, 8 GB                                                                                                                                              |
| F9  | P2       | Prompts (D1)      | No adversarial corpus; spoken `</subtitles>` not neutralized; an injected but correctly numbered answer was accepted.                                          | fixed: corpus of 10, delimiter neutralizing, length guard ([07 §2.5](../specification/07-ASR-And-Translation.md#25-prompt-injection-hygiene))                               |
| F10 | P2       | Supply chain (E2) | Binary checksums were recorded by setup but never checked by the engine.                                                                                       | fixed: startup check, reported in `/v1/health` and `status`                                                                                                                 |
| F11 | P2       | Privacy (C2)      | No way to clear cached audio from the UI; jobs (what you watched) kept forever.                                                                                | fixed: Models → Clear (`POST /v1/media/clear`); jobs dropped after 30 days                                                                                                  |
| F12 | P2       | Pairing (B2)      | The Vite port (:5173) was trusted in every build, and any loopback origin was labelled "The Sublight Player" on the approval page.                             | fixed: `devOrigins` only when developing; the label names known Players only                                                                                                |
| F13 | P3       | Engine (A5)       | JSON answers, including the token claim, had no `Cache-Control`.                                                                                               | fixed: `no-store` on `/v1/*`                                                                                                                                                |
| F14 | P3       | Config (G1)       | `~/.sublight` (jobs, logs) was world-readable; `config.json` 0644 on older installs.                                                                           | fixed: home 0700, config 0600, both narrowed on load                                                                                                                        |
| F15 | P3       | Subprocesses (A8) | Header values could carry CR/LF into ffmpeg `-headers`; no `--` before URLs for yt-dlp.                                                                        | fixed                                                                                                                                                                       |
| F16 | P3       | Glossary (D2)     | U+2028/U+2029 weren't refused.                                                                                                                                 | fixed                                                                                                                                                                       |
| F17 | P3       | Pairing (B2)      | A local process (another user on the machine) can forge origins and pair without the viewer noticing. The whisper secret is visible in the process list.       | won't-fix for Beta 1: loopback TCP can't tell users apart; multi-user hosts are out of scope, documented in [ADR-0022](../architecture/decisions/0022-one-click-pairing.md) |
| F18 | P3       | Extension (F2)    | The overlay's shadow root is open: page scripts can read caption text.                                                                                         | scheduled (M07): closed roots need the e2e hooks reworked; with F3/F5 fixed the text is the page's own video                                                                |
| F19 | P3       | Extension (F4)    | After a SW restart an offscreen capture can outlive its controller.                                                                                            | scheduled (M07): close orphaned offscreen documents at SW start                                                                                                             |
| F20 | P3       | Relay (A10)       | Relay `fetch` follows redirects on every request.                                                                                                              | scheduled (M07): re-check each redirect target against F5's rule                                                                                                            |
| F21 | P3       | Extension (F1)    | The dev extension ID is allowlisted in every build (its key is public).                                                                                        | won't-fix: it is the ID every unpacked install has; a store build gets its own ID via `allowedOrigins`                                                                      |
| F22 | P3       | Engine            | No cap on concurrent WebSockets; the job map is never pruned in memory; model files are hash-checked at install only.                                          | scheduled (M07)                                                                                                                                                             |

Criteria that passed as they were:

- A1 loopback binding, A2 token on every data route (constant-time), A3 Host checks, A4 CORS allowlist, A9 path handling.
- B1 CSPRNG token, B3 no token in logs, URLs or WS queries.
- C1 outbound traffic limited to model downloads, the page's own media and yt-dlp. C3 no telemetry.
- D3 LLM output never executed or rendered as HTML.
- E1 pinned models with SHA-256, E3 licenses recorded.
- F3 no `innerHTML` anywhere, F5 no eval or remote code.

## 5. Fixes & follow-ups

| Finding         | Fix (commit)                                                                      | Verified by                                                   | Date       |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| F1, F6, F8, F15 | `dd58afa` relays media-only, local-file-free and bounded                          | `tests/hardening.test.ts`, e2e HLS and Open-in-Player         | 2026-09-27 |
| F7              | `0894877` bound request bodies                                                    | `hardening.test.ts` (413 on pairing)                          | 2026-09-27 |
| F5              | `9149492` fetch page videos only from the internet                                | `hardening.test.ts` (address ranges, resolve route)           | 2026-09-27 |
| F12, F14        | `43c14fb` dev Player only when developing; private home; `a8e1519` private config | `hardening.test.ts`, `config.test.ts`                         | 2026-09-27 |
| F2              | `ad58b1e` worker secrets                                                          | real whisper and Qwen integration tests                       | 2026-09-27 |
| F3              | `3df98c1` web pages can't drive sublight                                          | extension e2e suite                                           | 2026-09-27 |
| F4              | `f51ca6a` ask before opening a handed-over video                                  | extension e2e (Open in Player, HLS)                           | 2026-09-27 |
| F9, F16         | `1e33772` translation hardening                                                   | `tests/injection.test.ts`                                     | 2026-09-27 |
| F10             | `b94fcd5` worker binary checksums                                                 | `tests/verify.test.ts`, real `~/.sublight/bin` all `ok`       | 2026-09-27 |
| F11             | `07416ac` job retention; `0bec4fd`, `cbba31f` audio cache clear                   | `retention.test.ts`, `routes.test.ts`, `ModelsPanel.test.tsx` | 2026-09-27 |
| F13             | `0894877` `no-store` on the API                                                   | `app.test.ts`                                                 | 2026-09-27 |

## 6. Lessons for the project

- The boundary held where it was designed (token, Host, Origin); the gaps were **trusted parts relaying a page's wishes**: the content script, the hand-over link, the relay. [ADR-0024](../architecture/decisions/0024-web-supplied-urls-and-handoffs.md) states the rule: pages report, the viewer decides, and page-supplied URLs reach only the internet.
- Third-party servers we spawn inherit their own defaults (open CORS). Every worker now needs a per-spawn secret; add that to the checklist for new workers.
- The live-model injection run (the corpus against Qwen) is still to do when translation is revisited.

## 7. Sign-off

- Auditor: code reviews plus dynamic checks · Owner: project maintainer · Date: 2026-09-27
- Closed: every finding has a disposition; no P0/P1; all P2 fixed.
