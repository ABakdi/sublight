# sublight

**Local, AI-powered subtitles for any video — perfect sync, any language, fully private.**

sublight is a web-based video player and browser extension (Chromium first, Firefox later) that lets you add subtitles to **any video on the internet** — or to **videos you've downloaded locally** — and view them in different languages, accurately translated and tightly synced to the audio.

All AI runs **locally** on your machine with **open-source models** (OpenAI Whisper family for speech-to-text, an open-weight LLM for translation). No cloud, no uploads, full privacy. Audio never leaves your computer.

---

## Why sublight exists

Watching a foreign-language video usually means hunting for subtitles, hoping they exist, and watching them drift out of sync. Streaming platforms gate caption quality behind their own infrastructure, and most videos on the internet simply have no subtitles at all.

sublight generates them for you on the spot:

- **Transcription** — Whisper (open-source, runs locally) converts speech to text with **word-level timestamps**.
- **Perfect sync** — timestamps are anchored to the actual audio you played, so captions land on the exact spoken word, then refined in a second pass.
- **Any language** — an open-weight local LLM translates the transcript fluently, keeping meaning (not just words), presented as separate subtitle tracks or as dual-language (source + translation) for language learning.

## How it works

Three cooperating parts, all running on your machine:

| Part | What it does |
|---|---|
| **Sublight Engine** | A local companion server (`127.0.0.1`). Receives audio, runs Whisper + the translation model, streams progress back. Installed once, runs in the background. |
| **Sublight Player** | A React web app. Plays local video files (no upload — it's your disk) and page videos handed over by the extension, manages transcription projects, renders styled subtitles, exports SRT. |
| **Sublight Extension** | A Chromium/Brave extension (Manifest V3). Injects a subtitle overlay into **any** website playing a video (YouTube, Vimeo, embedded players…), captures the tab's audio, and hands it to the engine. |

```
┌─────────────┐   HTTP/WS + bearer token   ┌───────────────────┐
│  Extension  │ ◄─────────────────────────► │                   │
│   (any site)│                             │   Sublight Engine │──► whisper.cpp (ASR)
└─────────────┘                             │   (localhost)     │──► llama.cpp (translation)
┌─────────────┐                             │                   │──► ffmpeg (audio)
│  Player App │ ◄─────────────────────────► └───────────────────┘
│ (local files)│      all audio stays on this machine
└─────────────┘
```

All open-source, runs locally, models downloadable on demand.

## Feature highlights

- 🔒 **100% local & private** — no audio or transcript ever leaves the machine
- 🎬 **Online videos** — subtitles on YouTube and any site with a `<video>` element, including embedded iframes
- 🚀 **Open in Sublight Player** — one click moves any page's video (YouTube included) into the full player: a new tab plays it with every player feature, resumed where you left off ([M05b](docs/plan/milestones/05b-Open-in-Player.md))
- 💾 **Local files** — play downloaded videos in the Sublight Player and caption them
- 🌍 **Any language** — accurate, meaning-preserving translation via a local open-weight LLM
- ⏱ **Precise sync** — word-level timestamps, live capture anchoring, second-pass refinement
- 🎨 **Full styling** — color, background, size, font, outline, position, alignment — per-user, persisted
- 📥 **Export SRT** (VTT planned) — take your subtitles anywhere
- 🛠 **Extensible** — the docs specify every component; later milestones add an editing suite and language-learning integration

## Technology

- **Frontend** — React 19 · TypeScript 5 · Vite · Tailwind CSS 4 · Zustand
- **Extension** — Manifest V3 · WXT framework (Chromium/Brave first, Firefox later)
- **Engine** — Node.js 22 · TypeScript · Hono · WebSockets
- **AI runtimes** — [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (ASR) · [llama.cpp](https://github.com/ggerganov/llama.cpp) (translation LLM) · ffmpeg (audio)
- **Models** — Whisper (MIT), Qwen2.5 (Apache-2.0) — all open source, run locally
- **Target hardware** — 32 GB RAM · 4 GB VRAM GPU (Quadro T1000) · i7 9th gen

See [docs/Home](docs/Home.md) for the full documentation vault.

---

## Documentation

The `docs/` folder is an **Obsidian vault** used as the living specification for sublight. Every file links to every other; start at [docs/Home.md](docs/Home.md).

| Area | Folder | What lives there |
|---|---|---|
| **Home** | [docs/Home.md](docs/Home.md) | Vault landing page, reading order, conventions |
| **Architecture** | [docs/architecture](docs/architecture/README.md) | System-wide design, decisions, requirements, diagrams |
| **Plan** | [docs/plan](docs/plan/README.md) | Roadmap, milestones, tasks, acceptance criteria |
| **Specification** | [docs/specification](docs/specification/README.md) | Detailed component specs, data model, protocol, failure modes |
| **Checkpoints** | [docs/checkpoints](docs/checkpoints/README.md) | Post-release test results, bugs found, gaps discovered |
| **Audits** | [docs/audits](docs/audits/README.md) | Security / code / quality audits and their fixes |

### Table of contents

- **Architecture**
  - [Architecture overview](docs/architecture/README.md)
  - [Requirements](docs/architecture/Requirements.md) — hardware, software, non-functional targets
  - [Decisions (ADR index)](docs/architecture/Decisions.md) — all significant technical decisions, past and future
  - [Diagrams](docs/architecture/diagrams/) — components, data flow, deployment
- **Plan**
  - [Plan overview](docs/plan/README.md)
  - [Roadmap](docs/plan/Roadmap.md) — milestones at a glance
  - [Milestone 00 — Foundations](docs/plan/milestones/00-Foundations.md) … [09 — Language learning](docs/plan/milestones/09-Language-Learning.md)
  - [Milestone 05b — Open in Sublight Player](docs/plan/milestones/05b-Open-in-Player.md) — move any page's video into the full player
- **Specification**
  - [Specification overview](docs/specification/README.md)
  - [System overview & components](docs/specification/01-System-Overview.md)
  - [Data model](docs/specification/02-Data-Model.md)
  - [Engine protocol](docs/specification/03-Protocol.md)
  - [Player app](docs/specification/04-Player-App.md)
  - [Overlay rendering](docs/specification/05-Overlay-Rendering.md)
  - [Engine server](docs/specification/06-Engine-Server.md)
  - [ASR & translation pipelines](docs/specification/07-ASR-And-Translation.md)
  - [Audio capture](docs/specification/08-Audio-Capture.md)
  - [Browser extension](docs/specification/09-Browser-Extension.md)
  - [Non-goals & failure modes](docs/specification/10-Non-Goals-And-Failure-Modes.md)
- **Checkpoints** — [index](docs/checkpoints/README.md) · [template](docs/checkpoints/Template.md) · [Beta 1 checklist](docs/checkpoints/Beta-1-Checklist.md)
- **Audits** — [index](docs/audits/README.md) · [template](docs/audits/Template.md) · [Security baseline plan](docs/audits/Security-Baseline-Plan.md) · [Code quality plan](docs/audits/Code-Quality-Baseline-Plan.md)

## Hardware requirements (target machine)

| Resource | Requirement | Notes |
|---|---|---|
| RAM | **32 GB** | Whisper + LLM can offload layers to system RAM; headroom for the browser |
| GPU VRAM | **4 GB** (Quadro T1000) | Fits Whisper `small`/`base` and a quantized 3–4B LLM **one at a time** |
| CPU | i7-9750H (6C/12T, AVX2) | AVX2 makes CPU-only fallback viable |
| Disk | ~5 GB models + cache (SSD preferred) | See [Requirements](docs/architecture/Requirements.md) |

> **Assumption:** the target GPU is a **Quadro T1000** (Turing, 4 GB). The architecture deliberately works with any NVIDIA card ≥4 GB and degrades gracefully to CPU-only.

## Development status

The repo is at **Milestone 00 (Foundations)** — currently documentation only. See [docs/plan/Roadmap.md](docs/plan/Roadmap.md) for the full plan.

## License & ethics notes

- sublight's own code: see the repository's license file (TBD at M00).
- AI models are open source; license compatibility is tracked in [ADR-0016](docs/architecture/decisions/0016-model-licensing.md).
- Captioning **DRM-protected** streams (Netflix, etc.) is explicitly **out of scope**. Downloading streams via `yt-dlp` (an optional power feature) must respect each platform's terms of service — see [Non-Goals](docs/specification/10-Non-Goals-And-Failure-Modes.md).