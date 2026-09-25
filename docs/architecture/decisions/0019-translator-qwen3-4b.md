---
tags: [architecture, decision]
status: accepted
date: 2026-09-25
---

# ADR-0019 — Translator model: Qwen3-4B-Instruct-2507 (Apache-2.0)

**Status:** accepted — replaces the _model choice_ in [ADR-0009](0009-translation-stack.md); its approach (paragraph chunks, numbered lines, validation) stands.

## Context

[ADR-0009](0009-translation-stack.md) picked Qwen2.5-3B-Instruct as the translator, believing it was Apache-2.0. Pinning the manifest in M02 showed it isn't: the 3B size is under the **Qwen Research License**, which forbids commercial use ([ADR-0016](0016-model-licensing.md)). The project wants models that are open source **and** usable commercially.

Candidates checked on Hugging Face (2026-09-25), all around 3–4B so they fit the 4 GB GPU at 4-bit:

| Model                      | License                     | Notes                                                                                        |
| -------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| **Qwen3-4B-Instruct-2507** | **Apache-2.0**              | Direct successor of the Qwen2.5 line; text-only instruct (no "thinking" mode); 119 languages |
| Qwen3.5-4B                 | Apache-2.0                  | Newer, but a vision-language model (image-text-to-text)                                      |
| SmolLM3-3B                 | Apache-2.0                  | Fully open data; 8 languages only                                                            |
| Phi-4-mini-instruct (3.8B) | MIT                         | Multilingual but weaker outside major European languages                                     |
| Llama-3.2-3B-Instruct      | Llama 3.2 Community License | Not an OSI license; usage restrictions                                                       |
| Gemma-3-4B-it              | Gemma Terms of Use          | Not an OSI license; usage restrictions                                                       |

## Decision

- **Default translator: Qwen3-4B-Instruct-2507, GGUF Q4_K_M** (2.50 GB), manifest id `qwen3-4b-instruct`, license Apache-2.0.
- Qwen publishes no GGUF for this release, so the manifest pins **bartowski's** quantization of the upstream weights (`Qwen/Qwen3-4B-Instruct-2507` @ `cdbee75f`): repo revision `ae44f08e` and the file's SHA-256. The engine refuses anything else ([ADR-0016](0016-model-licensing.md)).
- Runs in **llama.cpp `llama-server` b11174**, built from a verified commit by `pnpm engine:setup-llama`.
- **NLLB-200** stays out of the default path: CC-BY-NC is non-commercial, which conflicts with the same requirement.

## Consequences

**Good:** commercially usable end to end (Whisper MIT + Qwen3 Apache-2.0); a newer, stronger multilingual model in the same size class; the non-thinking instruct variant answers directly, which suits the strict numbered-lines protocol.
**Cost:** 4B at Q4_K_M ≈ 2.5 GB of weights plus KV cache: the model only fits when whisper isn't resident, so the engine swaps ASR ↔ LLM between jobs (Spec 06 §2). A third-party quantization is trusted by hash, not by publisher; if Qwen ships an official GGUF, switch to it.

## Alternatives considered

- **Keep Qwen2.5-3B** under the research license — rejected: not commercially usable.
- **Qwen2.5-1.5B / 7B (Apache-2.0)** — 1.5B is noticeably weaker; 7B at Q4 (~4.7 GB) doesn't fit 4 GB of VRAM without heavy CPU offload.
- **Quantize the upstream weights ourselves** — possible later (needs an ~8 GB download and a conversion step); the pinned SHA-256 already locks the bytes.

## Links

- [ADR-0009 — translation approach](0009-translation-stack.md) · [ADR-0016 — licensing](0016-model-licensing.md) · [ADR-0018 — Whisper translate for English](0018-whisper-translate-to-english.md)
- [Spec 06 §7 — llama worker](../../specification/06-Engine-Server.md) · [Spec 07 §2 — translation pipeline](../../specification/07-ASR-And-Translation.md) · [M04](../../plan/milestones/04-Translation-Pipeline.md)
