---
tags: [architecture, decision, security]
status: accepted
date: 2026-09-27
---

# ADR-0024: What web pages may make sublight do

**Status:** accepted. From the [first security baseline](../../audits/2026-09-Security-Baseline.md).

## Context

The engine is protected against web pages by the token and the Host/Origin checks ([Protocol §3](../../specification/03-Protocol.md#3-auth--hardening)). The audit found three ways a page could still steer it, through trusted parts of sublight rather than around them:

1. **The content script.** It runs in every page and talks to the service worker. The SW accepted popup requests from it, and it started a new captions job (the engine fetching a URL of the page's choosing, with the viewer's browser cookies when that option is on) whenever the page reported "the next video".
2. **The Player hand-over.** `#sl=` links are plain URLs: any site could open the Player with a payload that made the engine resolve and download an address it chose.
3. **The engine itself.** Given such a URL, it fetched it, including addresses on the viewer's computer and local network (routers, admin pages, other local servers), and relayed the result.

## Decision

- **Page-supplied URLs reach only the internet.** `pageUrl`, `mediaUrl` and the URL yt-dlp resolves them to must resolve to public addresses. Loopback, private (RFC 1918, CGNAT), link-local, unique-local, multicast and unspecified ranges fail with `MEDIA_UNREACHABLE`. `config.allowPrivateNetworks` opts in for a home media server. The check runs at resolve time; a DNS answer that changes between the check and the fetch is out of scope.
- **Pages report, the viewer decides.** The SW takes popup and Options requests only from extension pages. A page may ask to caption the next video only in a tab where the viewer turned captions on, and only on that site.
- **A hand-over waits for the viewer.** The Player shows "Open this video?" with the site before it fetches or saves anything. The user-agent hint must be one printable header value.

## Consequences

- Captions, "Open in Player" and live captions work as before on public sites. The fixture sites in e2e set `allowPrivateNetworks`.
- "Open in Sublight Player" takes one more click. A hand-over signed by the extension (a key shared at pairing) could remove it later.
- A local media server needs `allowPrivateNetworks: true` in `config.json`.

## Alternatives considered

- **Block only IP literals:** misses `localhost`, `*.local` and any name that resolves privately.
- **Trust the hand-over from its referrer:** extension-opened tabs have none, and a page can suppress its own.
- **Drop cookies from hand-overs instead of confirming:** cookies go only to the site's own domain; the harm is the fetch itself.
