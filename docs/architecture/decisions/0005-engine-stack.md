---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0005 — Engine stack: Node + TypeScript, whisper.cpp / llama.cpp subprocesses

**Status:** accepted

## Context

The engine must orchestrate ASR + translation on a 4 GB VRAM GPU with a CPU fallback, be portable (Linux now, Windows/macOS later), and stay maintainable by a small team that already lives in TypeScript. The best ASR open-source runtime is the Whisper family; the best translation runtimes are either CTranslate2-based Python libs (`faster-whisper`/NLLB) or llama.cpp. Python brings its own environment (venvs, pip, torch-free installs help but CUDA wheels still bite); C/C++ runtimes ship as single static binaries that need no Python.

## Decision

The engine is **Node.js 22 + TypeScript**, and all inference runs in **managed subprocesses**:

| Work            | Runtime                                               | Interface                                                               |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Speech-to-text  | **whisper.cpp** (`whisper-server`, CUDA or CPU build) | Its HTTP server: upload audio → JSON with **segment + word timestamps** |
| Translation     | **llama.cpp** (`llama-server`, GGUF Q4 model)         | OpenAI-compatible `/v1/chat/completions`                                |
| Audio normalize | **ffmpeg** (static binary)                            | `ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav`                   |

The Node engine owns lifecycle, health checks, model swapping, job queue, caching, and the single public API ([ADR-0013](0013-engine-api.md)).

Why not Python faster-whisper: it's excellent, but adds a Python environment to every install and a second language to the codebase. whisper.cpp reaches near-parity for our needs (word timestamps, good accuracy, AVX2 + CUDA, no tensor core requirement) and gives **identical runtime handling for ASR and LLM** (two binaries, one model store). We keep `faster-whisper` as an alternative if whisper.cpp quality disappoints on a language we need ([ADR-0009](0009-translation-stack.md)).

## Consequences

**Good:** single-language codebase; static binaries simplify packaging (later: bundled installers); CPU fallback is just a different binary; model store is just files in `~/.sublight/models`.
**Cost:** whisper.cpp/llama.cpp servers must be configured carefully (flags, ports, health); we must pin binary versions and checksums ([ADR-0016](0016-model-licensing.md)); CUDA builds must match the T1000 (Turing, CUDA compute 7.5, no tensor cores → fp16 off, int4 works).

## Alternatives considered

- **Python engine (FastAPI + faster-whisper + NLLB)** — strongest raw ASR ecosystem; rejected for env/ops complexity and language split. Might return as a _sidecar_ if a specific model (e.g. whisperX alignment) proves necessary.
- **Ollama as the translation runtime** — nice UX but an extra app to install/update and less control over scheduling alongside whisper; rejected for v1, revisited in M09 planning.
- **transformers.js (WebGPU in-page)** — rejected in [ADR-0004](0004-local-engine-outside-extension.md).

## Links

- [Spec 06 — Engine Server](../../specification/06-Engine-Server.md)
- [Requirements §4 model matrix](../../architecture/Requirements.md)
- [ADR-0004](0004-local-engine-outside-extension.md) · [ADR-0009](0009-translation-stack.md)
