# Installing sublight (Beta 1)

sublight has three parts: the **engine** (runs the speech and translation
models on your computer), the **browser extension** (captions on any video
page) and the **Player** (a web app for local files and editing). Everything
runs locally; nothing is uploaded.

## What you need

- Linux (tested) or macOS; Windows works but autostart is manual.
- Node.js 22 or newer, pnpm 10, `ffmpeg`, and for speech recognition cmake
  plus a C++ compiler (CUDA is used when available).
- Brave or Chromium (Chrome 137+ refuses unpacked extensions from the
  command line, but loading by hand works).
- About 2 GB of disk for the default speech model, 4 GB more for the local
  translation model.

## 1. Build

```sh
git clone https://github.com/ABakdi/sublight && cd sublight
pnpm install
pnpm build
pnpm engine:setup-whisper   # the speech recognizer (a few minutes)
pnpm engine:setup-ytdlp     # captions ahead of playback for YouTube and others
```

## 2. Start the engine

```sh
pnpm engine start --detach   # or: node apps/engine/dist/sublight-engine.mjs start --detach
pnpm engine status           # running at http://127.0.0.1:17421 · …
pnpm engine stop
```

`apps/engine/dist/sublight-engine.mjs` is the whole engine in one file: copy
it anywhere and run it with Node. Its data (models, caches, logs, config)
lives in `~/.sublight`.

### Start it when you log in

```sh
pnpm engine autostart enable          # Linux: systemd user unit; macOS: LaunchAgent
pnpm engine autostart enable --print  # just show the file it would write
pnpm engine autostart disable
```

The engine then starts at your next login and restarts if it crashes (not
after `stop`). On Linux, to keep it running while you're logged out, also
run `loginctl enable-linger`. On Windows, `sublight-engine autostart` prints
Task Scheduler steps.

## 3. Load the extension

Open `brave://extensions` (or `chrome://extensions`), switch on **Developer
mode**, click **Load unpacked** and pick `apps/extension/.output/chrome-mv3`.
Keep Developer mode on.

## 4. Pair

Click the sublight toolbar icon → **Pair with the engine**. A tab from the
engine opens with a 4-digit code: check it matches the one in the popup, and
click **Approve**. The Player pairs the same way from its Caption tab.

## 5. Models

The first caption asks to install the speech model; the Player's **Models**
tab lists all of them with their size and the free disk space, and removes
the ones you don't use.
