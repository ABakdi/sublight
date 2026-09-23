---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0004 — AI runs in a local companion engine, never in the extension/page

**Status:** accepted

## Context

Subtitle generation needs ~2–3 GB models (Whisper `small`), up to several GB for a translation LLM, and long-running CPU/GPU work. A browser context is hostile to all of it:

- **MV3 service workers** die after ~30 s idle, can't open sockets, and are heavily memory-limited.
- **Content scripts** die with the page, are throttled in background tabs, and can't spin native threads.
- **Web pages** can't access the GPU locally at all (WebGPU exists but is a poor fit for whisper/llama inference and would require a browser-based model runtime we'd have to write).
- Consequence for users: models must run **on their machine**, not in the cloud (privacy is a core requirement, [F6.1](../../architecture/Requirements.md)).

## Decision

All AI inference runs in a **local companion process — the Sublight Engine** — a Node server bound to `127.0.0.1` that owns:

- the models (whisper.cpp, llama.cpp subprocesses),
- the GPU/CPU scheduling (one model resident at a time, jobs serialized),
- the job queue, caching, and content-hash dedupe,
- ffmpeg audio normalization.

The extension and player are **thin clients**: they capture/provide audio, receive progress events, and render results. Browsers never touch model weights, never decode audio for the engine, and hold no long-lived inference state.

## Consequences

**Good:** reliable long jobs; uniform API for both clients; privacy preserved (nothing leaves the box); engine can be tested headlessly; future remote engines are conceivable but explicitly out of scope.
**Cost:** users must run the engine (launch on login or via `npm start`/packaged app); localhost transport introduces a security boundary that must be engineered properly ([ADR-0006](0006-engine-transport.md), [security audit plan](../../audits/Security-Baseline-Plan.md)).

## Alternatives considered

- **In-extension inference** — impossible per MV3 constraints above.
- **Cloud/API inference** — violates privacy requirement; rejected.
- **WebGPU in-page inference (transformers.js + whisper)** — real possibility, but: downloaded models land in the browser's cache not a shared store, no GPU swap/scheduling control, slower, and duplicates the model manager. Rejected for v1; noted as a possible *fallback* path in [Spec 10](../../specification/10-Non-Goals-And-Failure-Modes.md) if the engine ever becomes a barrier to entry.

## Links

- [Architecture overview](../../architecture/README.md)
- [Spec 06 — Engine Server](../../specification/06-Engine-Server.md)
- [ADR-0006](0006-engine-transport.md) · [ADR-0005](0005-engine-stack.md)