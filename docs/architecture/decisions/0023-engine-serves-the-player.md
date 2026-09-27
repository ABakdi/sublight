---
tags: [architecture, decision]
status: accepted
date: 2026-09-27
---

# ADR-0023: The engine serves the Player, on an origin of its own

**Status:** accepted. Replaces "packaged as an extension page in prod" in [Spec 04](../../specification/04-Player-App.md).

## Context

The Player is a static React build, but it was only reachable through Vite (`pnpm dev:player`, `http://localhost:5173`). [M06](../../plan/milestones/06-Beta-Release.md) asks for sublight without a terminal. The Player needs the engine for everything beyond plain playback, and the engine already runs on the user's computer.

## Decision

- The engine serves the built Player from a second loopback port, `http://127.0.0.1:17420` (`PLAYER_DEFAULT_PORT`, `config.player.port`; `0` turns it off). It serves static files only: GET/HEAD, loopback `Host` only, no path escapes, `index.html` for app routes, and hashed assets cached as immutable.
- The build is found at `config.player.dir`, then `player/` next to the engine bundle (a release), then the repository's `apps/player/dist`. With no build, or with the port taken, the engine runs without the Player and logs why.
- **Its own origin, not the engine's.** The engine's origin is the one that may approve pairings ([ADR-0022](0022-one-click-pairing.md)). The Player pairs like any other client: its origin is on the allowlist, and it asks, waits for approval and claims the token.
- The extension's "Open in Sublight Player" defaults to this address. Developers point it at `:5173` in Options.

## Consequences

- One command (`sublight-engine start`) gives both the engine and the Player, and autostart covers both. The e2e suite opens the served Player and pairs it in one click.
- Projects live in IndexedDB per origin: projects made on the dev server (`:5173`) don't show in the served Player, and the other way round.
- The release ships `sublight-engine.mjs` with the Player next to it in one archive.
- If the engine is down, so is the Player. It can't do much without the engine anyway, and the extension says how to start it.

## Alternatives considered

- **Serve the Player from the engine's own origin (`:17421`):** simpler, but then any bug in the Player's larger surface (subtitles, media URLs) would run on the origin that approves pairings.
- **Package the Player as an extension page:** it would need the extension even for local files, would tie Player releases to extension updates, and would grow the extension.
- **A separate static server or desktop wrapper:** one more thing to install and start.
