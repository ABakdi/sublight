---
tags: [home, index]
updated: 2026-09-23
---

# sublight — Documentation Home

> **Local, AI-powered subtitles for any video — perfect sync, any language, fully private.**

This vault is the **living specification** for the sublight project. It is both an Obsidian vault and a set of plain Markdown files that render on GitHub. Everything here is meant to be read as a network: start anywhere, follow the links.

---

## How to navigate this vault

Start with the areas below. Suggested reading order for newcomers:

1. **[Project README](../README.md)** (repo root) — one-paragraph summary of the product.
2. **[Architecture overview](architecture/README.md)** — how the system fits together and the big picture.
3. **[Specification: System Overview](specification/01-System-Overview.md)** — components and their relationships in detail.
4. **[Roadmap](plan/Roadmap.md)** — where we're going and what's next.
5. Then dive anywhere — decisions, checkpoints, audits — as you work.

---

## The documentation areas

| Area | Folder | Purpose |
|---|---|---|
| 🏛 **Architecture** | [architecture/](architecture/README.md) | System design, **decisions** (the ADR log), requirements, diagrams. Anything that — if changed — would considerably impact the project lives here and *must* be documented. |
| 🗺 **Plan** | [plan/](plan/README.md) | The roadmap, milestones, and every task per milestone with acceptance criteria. |
| 📐 **Specification** | [specification/](specification/README.md) | Detailed specs of each system component: how they work, their interfaces, diagrams, and how they relate. |
| ✅ **Checkpoints** | [checkpoints/](checkpoints/README.md) | After each release/beta: what we tested, bugs found, features missed, things forgotten or underspecified. |
| 🔍 **Audits** | [audits/](audits/README.md) | Periodic security, code, and quality audits — findings, fixes, follow-ups. |

### Direct links

- 🏛 [Architecture overview](architecture/README.md) · [Requirements](architecture/Requirements.md) · [Decisions index](architecture/Decisions.md) · [Diagrams](architecture/diagrams/)
- 🗺 [Plan](plan/README.md) · [Roadmap](plan/Roadmap.md) · [Milestones](plan/milestones/)
- 📐 [Spec overview](specification/README.md) · [System overview](specification/01-System-Overview.md) · [Data model](specification/02-Data-Model.md) · [Protocol](specification/03-Protocol.md)
- ✅ [Checkpoints](checkpoints/README.md) · [Beta-1 checklist](checkpoints/Beta-1-Checklist.md)
- 🔍 [Audits](audits/README.md) · [Security baseline plan](audits/Security-Baseline-Plan.md)

---

## The system in three sentences

1. A **local engine** (Node.js server on `127.0.0.1`) runs open-source models: **whisper.cpp** for speech-to-text with word-level timestamps, and **llama.cpp** with an open-weight LLM for meaning-preserving translation.
2. A **browser extension** (Chromium/Brave, MV3) injects a subtitle overlay into any site's video — capturing the tab's audio and streaming progress — while a companion **React player app** does the same for local files.
3. Subtitle **tracks** (any language, styled, word-synced) render in a Shadow DOM overlay and export as **SRT** — all completely offline, nothing leaves the machine.

Hardware target: **32 GB RAM · 4 GB VRAM (Quadro T1000) · i7 9th gen** → see [Requirements](architecture/Requirements.md).

---

## Conventions used in this vault

- **Links** — plain relative Markdown links, e.g. `text → architecture/Requirements.md`, so the vault renders on both Obsidian *and* GitHub. Obsidian wikilinks also work; prefer relative links for anything that must survive GitHub rendering.
- **Diagrams** — [Mermaid](https://mermaid.js.org/) code blocks; rendered natively by Obsidian and GitHub.
- **Metadata** — every file starts with YAML frontmatter (`tags`, `status`, `updated`).
- **Statuses** — used across files in italic `_status: …_` or frontmatter. Legend:
  - Decisions: `proposed` → `accepted` → `superseded` / `deprecated`
  - Specs: `specified` (written down) / `implemented` / `planned` / `deferred`
  - Checkpoints / audits: `open` → `in-triage` → `closed`
- **Tags** — `#subsystem/<name>` for components, `#status/<state>` for lifecycle.
- **ADR** = Architecture Decision Record. The [Decisions index](architecture/Decisions.md) is the single list of "things we decided that, if changed, must be re-documented."

---

## How this vault is maintained

- All significant, cross-cutting choices go through an **[ADR](architecture/Decisions.md)** first, then flow into the **[specification](specification/README.md)**.
- Work items live in the **[plan](plan/README.md)**; each milestone links to the specs it implements and the ADRs it depends on.
- Every release produces a **[checkpoint](checkpoints/README.md)**.
- Periodically, an **[audit](audits/README.md)** reviews security, code quality, and model/dependency health.

**If you change something big — an engine transport, a model, a storage scheme — it needs an ADR entry *before* it hits the code.**