---
tags: [architecture, decision]
status: accepted
date: 2026-09-23
---

# ADR-0016 — Model licensing & supply-chain hygiene

**Status:** accepted

## Context

sublight's promise is **open-source models, installed locally**. "Open source" is a spectrum: MIT/Apache-2.0 (fully free), other licenses may allow use but restrict commercial distribution (CC-BY-NC for NLLB-200), and weights are hosted on Hugging Face where revisions can be replaced. If sublight ever becomes distributable/installable (M06 packaging), model licensing becomes a legal surface, and supply-chain trust is a security surface ([ADR-0006](0006-engine-transport.md)).

## Decision

- **Model registry is a pinned manifest**, not free-form downloads:
  - Each model has: `id`, `source` (HF repo), **pinned `revision` (commit SHA)**, **SHA-256 of the artifact**, license, size, VRAM class.
  - The engine installs **only from the manifest**; no arbitrary URL fetch from user input (blocks SSRF). Manual overrides are explicitly unsupported.
- **License allowlist:** ship models whose license permits the intended use (personal use today; re-check for distribution). Current plan:
  - Whisper ggml models, all sizes incl. large-v3-turbo (MIT) ✅ · NLLB-200 (**CC-BY-NC-4.0** — **non-commercial**: installable, but flagged in UI + excluded if sublight ever becomes commercial).
  - ⚠️ **Qwen2.5-3B-Instruct is _not_ Apache-2.0** (found while pinning the manifest, 2026-09-25): Hugging Face lists it under the **Qwen Research License** ("other"), which restricts commercial use. The 1.5B and 7B Instruct sizes _are_ Apache-2.0. **Open question for M04:** keep 3B (fine for personal use, flagged like NLLB), switch to 1.5B (Apache-2.0, weaker), or 7B (Apache-2.0, Q4 ≈ 4.7 GB: needs partial CPU offload on a 4 GB GPU). The manifest records the true license (`qwen-research`) meanwhile.
- Verify at download time; checksum mismatch → refuse to install (audited in [security baseline](../../audits/Security-Baseline-Plan.md)).
- Binaries (whisper.cpp, llama.cpp, ffmpeg) also pinned. whisper.cpp publishes no Linux server binary, so `pnpm engine:setup-whisper` builds `whisper-server` from a **pinned tag whose commit SHA is verified before building** (v1.9.4 → `927cfce3…`) and records the resulting binary's SHA-256 in `~/.sublight/bin/whisper.json`.

## Consequences

**Good:** trustworthy, reproducible installs; license story decided up-front instead of at legal time; the manifest doubles as the "what's on disk" inventory for audits.
**Cost:** manifest maintenance when models update; users who want a newer hat still wait for manifest bumps (one-person cadence is fine).

## Alternatives considered

- **Ad-hoc HF downloads (no pins)** — supply-chain risk and "the model changed under us" bugs; rejected.
- **Model auto-update** — differs from the "pinned, reproducible" principle; rejected (manual bump + checkpoint after).

## Links

- [Spec 06 §3 — Model manager](../../specification/06-Engine-Server.md)
- [Security baseline audit](../../audits/Security-Baseline-Plan.md)
- [Requirements §4 — model matrix](../../architecture/Requirements.md)
