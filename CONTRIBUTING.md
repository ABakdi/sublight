# Contributing to sublight

Thanks for considering contributing. This is a solo project at the moment, but a
few simple conventions keep it coherent.

## Getting started

- Requirements: **Node.js ≥ 22**, **pnpm 9** (`corepack enable`).
- Install: `pnpm install`
- Build everything: `pnpm build`
- The docs vault in `docs/` is the source of truth for _why_ decisions exist
  (ADRs) and _what/how_ things should work (specifications). Read the
  [Home](docs/Home.md) page before touching architecture.

## Command reference

| Command              | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `pnpm dev:player`    | Vite dev server for the player app (`:5173`)                              |
| `pnpm dev:engine`    | Engine dev server (`:17421`, tsx watch)                                   |
| `pnpm dev:extension` | WXT dev mode (load `apps/extension/.output/chrome-mv3` in Chromium/Brave) |
| `pnpm ext:try [url]` | Build the extension and open Brave/Chromium with it loaded (see below)    |
| `pnpm engine:token`  | Print the engine token to paste into the extension's Options page         |
| `pnpm lint`          | ESLint (flat config)                                                      |
| `pnpm lint:links`    | Docs link/anchor checker (must stay green)                                |
| `pnpm typecheck`     | `tsc --noEmit` across all workspaces                                      |
| `pnpm test`          | Vitest unit tests across all workspaces                                   |
| `pnpm e2e`           | Playwright (Chromium; Brave when installed)                               |
| `pnpm e2e:extension` | Extension e2e (builds the unpacked MV3 and loads it)                      |
| `pnpm sync:run`      | Transcribe the sync corpus through a running engine                       |
| `pnpm sync:measure`  | Sync-accuracy corpus report                                               |

## Running the engine with speech recognition

```sh
pnpm engine:setup-whisper      # once: builds whisper.cpp v1.9.4 (~15 min with CUDA)
pnpm dev:engine                # terminal 1
TOKEN=$(pnpm -s engine:token)
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17421/v1/models/whisper-small/install
pnpm engine:transcribe some-video.mp4 --out some-video.srt   # or --translate for English
```

Translation into other languages needs the LLM worker too:

```sh
pnpm engine:setup-llama        # once: builds llama.cpp b11174 (~20 min with CUDA)
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17421/v1/models/qwen3-4b-instruct/install
```

In the player: Tracks → **Translate…** on a track (the form can also install the model).

The build needs cmake and a C++ compiler; CUDA is used when `nvcc` is on
`PATH` or in `/opt/cuda` (pass `--cpu` to skip it). Models download from
pinned Hugging Face revisions and are SHA-256 checked. The engine's real-ASR
test (`apps/engine/tests/asr.integration.test.ts`) runs automatically once the
binary and whisper-small are installed, and `E2E_REAL_ASR=1 pnpm e2e` runs the
player's full caption journey against them.

In the player: open a video, pick the **Caption** tab, paste the token from
`pnpm engine:token` once, choose a model and click **Caption this video**.

## Trying the extension in a real browser

The quick way, from the repo root:

```sh
pnpm dev:engine          # terminal 1 (optional: test captions work without it)
pnpm ext:try https://www.youtube.com/watch?v=aqz-KE-bpKQ
```

`ext:try` builds `apps/extension`, then opens Brave (or Chromium) with the
unpacked build loaded into a dedicated profile under
`~/.sublight/browser-profiles/`. Your everyday profile is never touched. Flags:
`--browser brave|chromium|<path>`, `--fresh` (throwaway profile), `--no-build`,
`--debug-port 9222` (CDP, so scripts can drive the window).

Then:

1. **Pair:** run `pnpm engine:token`, open the extension's **Options**
   (toolbar icon → _Options & pairing_), paste the token and click Save. The
   status should turn to _Engine online_.
2. **Check a video:** on any page with a `<video>`, click the toolbar icon.
   The popup lists the video and its playhead. **Show test captions** draws
   a caption every 2.5 s stamped with its own start time, so you can check
   the overlay's position, sync, fullscreen and SPA navigation on that site.

**Loading it by hand** (e.g. into your own browser profile): open
`brave://extensions` or `chrome://extensions`, switch on **Developer mode**
and click **Load unpacked**, then pick `apps/extension/.output/chrome-mv3`.
Developer mode has to stay on: Chromium 13x+ disables unpacked extensions
after their first reload otherwise. Google Chrome 137+ ignores
`--load-extension`, so `ext:try` targets Brave and Chromium.

The build pins a public `key`, so every unpacked install gets the same ID
(`ehgdbfcecgkljnpmednociabmmjemfkf`), and the engine allowlists that origin
out of the box.

## Conventions

- **Commits**: conventional-commit style (`feat:`, `fix:`, `docs:`,
  `chore:`), small and self-contained.
- **Type-only imports**: use `import type` (enforced by ESLint).
- **Workspace boundaries** (see [ADR-0001](docs/architecture/decisions/0001-monorepo-layout.md)):
  `packages/core` is framework-free; `packages/overlay` only adds React; apps
  consume packages as workspace deps.
- **All cues/times** are integer milliseconds — no floats on the wire
  ([Spec 02](docs/specification/02-Data-Model.md)).

## Testing expectations

- Every PR must keep `pnpm lint`, `pnpm lint:links`, `pnpm typecheck`,
  `pnpm test`, and `pnpm build` green; CI enforces this.
- Docs changes must not break the link checker (`pnpm lint:links`).

## Docs

- [Home](docs/Home.md) · [Plan](docs/plan/README.md) · [Roadmap](docs/plan/Roadmap.md)
- Docs are an Obsidian vault; keep relative links and Mermaid diagrams valid.
