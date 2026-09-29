# Installing sublight

sublight has three parts: the **engine** (runs the speech and translation
models on your computer), the **browser extension** (captions on any video
page, and everything else in one popup) and the **Player** (your own files,
editing and export). Everything runs locally; nothing is uploaded.

Installing is two steps: a script, then the extension. After that there is
no terminal, token or pairing: the extension starts the engine when it
needs it, and the engine turns itself off when idle.

## What you need

- Linux, x64 or ARM (macOS and Windows: not yet).
- Brave, Chromium, Google Chrome, Vivaldi or Edge.
- About 2 GB of disk (the engine and the speech model), 2.5 GB more for the
  translator if you want captions in languages other than English.
- An NVIDIA graphics card is optional: with one, the models run on it.

## 1. Run the installer

```sh
curl -fsSL https://github.com/ABakdi/sublight/releases/latest/download/install.sh | bash
```

It installs into `~/.sublight`, without root:

- the engine and the Player, and Node 22 if you don't have it (pinned, checksum-checked)
- what the engine needs from your system (ffmpeg, a compiler and cmake, and the
  CUDA toolkit when there is an NVIDIA card with its driver), through your
  package manager, after asking; it never runs itself as root
- the speech recognizer (whisper.cpp, built for your GPU or processor),
  yt-dlp and the speech model; the translator if you say yes
- the extension, in `~/.sublight/extension`
- the browser registration that lets the extension start the engine

Run it again to update (or `~/.sublight/app/install.sh`). `--help` lists the options (`--cpu`, `--no-translation`,
`--yes`…).

## 2. Load the extension

Open `brave://extensions` (or `chrome://extensions`), switch on **Developer
mode** (top right), click **Load unpacked** and choose `~/.sublight/extension`.
Keep Developer mode on.

Why Developer mode: Chromium browsers install packed extensions only from their
web store, where sublight isn't published yet. The folder stays the same across
updates: after running the installer again, click the reload arrow on
sublight's card.

## 3. Use it

On any page with a video, click the sublight icon: **Caption this video**. The
engine starts by itself the first time (the icon lights up), and turns itself
off after 20 minutes without use (the icon greys).

The popup holds everything: the video, the caption style, the models, the
engine (on or off, and when it turns itself off) and the settings. **Open
Sublight Player** in its footer opens the Player for your own files.

## Removing it

```sh
~/.sublight/app/install.sh --uninstall
```

It asks before deleting your models and settings (`--purge` deletes them
without asking). Then remove the extension from the browser's extensions page.

## Privacy and local servers

Everything stays on your computer. The engine listens on `127.0.0.1` only, and
fetches nothing but the videos you caption and, once, the models (from pinned
sources, checked). Cached audio can be cleared from the popup's **Models** tab,
and finished jobs are forgotten after 30 days. For safety the engine only
fetches videos from the internet: to caption one from a media server on your
own network, set `"allowPrivateNetworks": true` in `~/.sublight/config.json`.

## From the source code

For development, see [CONTRIBUTING.md](CONTRIBUTING.md): `pnpm install`,
`pnpm build`, `pnpm engine setup whisper`, and `pnpm ext:try` to open Brave or
Chromium with the extension loaded and a development engine it can start.
