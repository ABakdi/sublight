---
tags: [plan, milestone]
status: not-started
updated: 2026-09-29
---

# M06b — Beta 1 readiness: one install, one place

**Goal:** Beta 1 is something I install with one script and one extension load, and then never touch a terminal, a token or a pairing page again. Everything is in the extension's popup, the Player feels like a real video player, and there is a website to download it from. The 0.1.0 release waits for this milestone and for the two pre-beta audits.

## Decisions

- **Installing is a bash script, then the extension in Developer mode.** `install.sh` installs everything that runs outside the browser. The extension zip is then loaded through **Developer mode → Load unpacked**. I'm not publishing to the Chrome Web Store for Beta 1. A browser extension can't install or start programs by itself, so the script does that part once. After that the extension handles the rest.
- **What the script does:**
  - installs the engine and the Player into `~/.sublight`, with Node if it is missing (pinned and checksum-checked)
  - installs the speech and translation runtimes (whisper.cpp, llama.cpp), ffmpeg and yt-dlp, prebuilt where a build exists for this machine and built otherwise
  - registers a native messaging host for Brave, Chromium and Chrome
  - unpacks the extension to a fixed folder and opens the browser's extensions page, with the two clicks to make
  - can uninstall everything
- **The extension runs the engine** through that native host. It gets the engine's token from the host, so there is no pairing and no token to copy. It starts the engine when something needs it, shows whether it is on or off, and the engine turns itself off when idle. Autostart at login stays available but is off by default.
- **The GPU when there is one.** On a machine with an NVIDIA graphics card and its driver, install.sh adds the CUDA toolkit to the system packages it installs (Arch `cuda`, Debian/Ubuntu `nvidia-cuda-toolkit`; elsewhere it points to NVIDIA's download and uses the CPU), and the speech and translation engines are built for the GPU. Without one, or if the GPU build fails, they are built for the CPU.
- **Developer mode** (Settings) shows the choice to run the models on the GPU or the CPU, and pairing by hand.
- **The Player comes with the install.** The engine serves it as before. The popup opens it, starting the engine first if it's off.
- Pairing and the token field stay under _Settings → Advanced_, for development.

## Tasks

### Bugs

- [x] **M06b.1** — (B8, P1) **Page videos whose link expires**. vinovo.to's player plays a plain mp4 from `<cdn>/stream/<token>`, and the token stops working (403) minutes after the page stops playing. Captioning in the Player then failed, and yt-dlp's "Unsupported URL" hid the 403.
  - Fix: when the Player plays a page video from the page's own link, the engine saves a copy in the background (`POST /v1/media/resolve`, `copy` in the relay status). If the link fails, the Player plays the copy (showing "Preparing media…" while it finishes). `url` jobs carry the relay id and caption the copy. A link the site refuses is reported as such, instead of yt-dlp's message.
  - _Accept:_ `apps/engine/tests/copy.test.ts` (the copy outlives the link; the refused link is named; the copy is captioned) and the Player's hand-over test pass. The vinovo embed captions in the Player: to check by hand.

### Install

- [ ] **M06b.2** — **`install.sh`** as described in _Decisions_: user-local (no sudo), idempotent (re-running it updates), and `--uninstall`. It checks the GPU and picks a CUDA, Vulkan or CPU runtime, checks every download against SHA-256, and ends by opening the extensions page with the steps to load the extension.
  - _Accept:_ on a clean Linux user without Node, cmake or a CUDA toolkit, the script plus loading the extension caption a YouTube video with GPU ASR.
  - _Progress (2026-09-29):_ `scripts/install.sh` installs from a release (`--from` a local one, else GitHub) checked against `SHA256SUMS`: system packages through the package manager (asks first), Node 22 when missing (pinned, checksum-checked), the engine, Player and extension, whisper.cpp, yt-dlp, whisper-small, llama.cpp if wanted, and the native host. Re-running it updates; `--uninstall` removes it. `sublight-engine setup` and `model` do the work, and `scripts/package.mjs` builds the release it installs. Tested in a throwaway home (install, update, uninstall). Still missing: prebuilt runtimes, so a machine without a CUDA toolkit builds for the CPU.

### The extension runs the engine

- [ ] **M06b.3** — **Native host**: `sublight-engine native-host` handles `status`, `start`, `stop`, `token` and `version`. Only the extension's pinned ID may connect. The extension gets the `nativeMessaging` permission, takes the token from the host and stops pairing.
  - _Accept:_ after the install, the extension captions a video with no pairing step; a rotated token re-syncs on its own.
  - _Progress (2026-09-29):_ the engine side is done: `sublight-engine native-host`, registered by install.sh, tested (framing, refusing other extensions, start/status/token/stop). The extension takes its token from it (kept in `storage.session`, out of content scripts' reach, fixing security pass 2 S1 for this path), and follows a replaced token after a 401; `ext:try` registers a development host. Checked end to end in Chromium and Brave (extension e2e: the real host hands the token over, the engine shows online, nothing paired).
- [ ] **M06b.4** — **Start on demand**: an engine request that finds it offline starts it through the host, shows _Starting…_, and retries once it answers.
  - _Accept:_ with the engine stopped, "Caption this video" captions with no other click.
  - _Progress (2026-09-29):_ `engineRequest` starts the engine through the host when it can't connect, then retries; unit-tested with a fake host. The popup shows _Engine off_ and _Engine starting…_.
- [ ] **M06b.5** — **Smart idle** in the engine:
  - Unload models after 5 min without a job, which frees VRAM and RAM.
  - Exit after 20 min without a job, live session, lease or relay download. Open WebSockets don't count.
  - The delays can be set, and there is a **Keep the engine running** switch. They are shorter on battery. The engine never stops during work.
  - _Accept:_ unit tests for each kind of activity; idle CPU ~0 % and VRAM freed after unload, measured; the exit is logged with its reason.
  - _Progress (2026-09-29):_ built as specified (Spec 06 §1, `idle.ts`): work never stops it, status reads don't count as activity, background engines exit and terminal ones stay, halved on battery; unit tests for each case, and a background engine with short delays exited by itself and logged why. The extension's background polls no longer start an idle engine. Not yet: the delays and the switch in the popup (M06b.6/7), and the idle CPU and VRAM measurement.
- [ ] **M06b.6** — **Engine status in the popup**: _Off · Starting · On · Busy · Idle (models unloaded)_, with an on/off switch. When the host is missing, the popup explains how to run `install.sh`.
  - _Accept:_ each state appears in the extension e2e (the host is faked in tests).
  - _Progress (2026-09-29):_ the popup's Engine tab ([Spec 09 §7](../../specification/09-Browser-Extension.md#7-popup--options)) with the switch and the idle delays; the extension e2e checks it with the real host (on, the switch, the settings). Still to do: the Off and Starting states in e2e, and the action icon showing the state (M06b.14).

### Everything in one place

- [ ] **M06b.7** — **The popup is the whole extension**, in tabs:
  - _This video_: captions, translate, Open in Player
  - _Style_: today's Options caption style, with its preview
  - _Models_: M06b.8
  - _Engine_: M06b.6, disk space, clear cache
  - _Settings_: browser login, English via Whisper or LLM, Player address, idle delays, start with the computer
  - The Options page opens the same UI full size. I'll try a side panel (`chrome.sidePanel`) for the same UI and keep whichever reads better.
  - _Accept:_ no flow in the Beta-1 matrix needs the Options page.
  - _Progress (2026-09-29):_ built: the popup's tabs and the full-page Options share the same sections. The side panel is not tried yet. "Start with my computer" isn't in Settings yet (autostart stays a command).
- [ ] **M06b.8** — **Models from the extension**: install with progress, remove, installed size and free disk space, as in the Player's Models panel. The engine client moves to a shared package used by both the extension and the Player (the two copies have drifted: [Q-3](../../audits/2026-09-Code-Quality-Q3.md) Q7).
  - _Accept:_ whisper-small and Qwen3-4B install and remove from the popup.
  - _Progress (2026-09-29):_ the popup's Models tab (install with progress, remove, disk space, cached audio). Not yet: the shared engine client package; the extension and the Player still each have their own.

### The Player

- [x] **M06b.9** — **Open Sublight Player** in the popup: it starts the engine if needed, then opens the Player.
  - _Accept:_ with the engine off, one click opens the Player.
  - _Done (2026-09-29):_ **Open Sublight Player** in the popup's footer starts the engine when it isn't online, then opens the Player it serves (the Player address from Settings); in the extension e2e.
- [ ] **M06b.10** — **Player UI/UX**:
  - a dark, light or system theme, switchable and remembered (design tokens; contrast checked in both)
  - a video-first layout, with the panels (Tracks, Caption, Style, Models) in a collapsible side drawer
  - a library with thumbnails and last position
  - empty states that say what to do next
  - job progress as unobtrusive toasts
  - usable down to a small window
  - _Accept:_ both themes pass WCAG AA contrast and full keyboard reachability.
  - _Progress (2026-09-29):_ themes (system, light, dark; the palette mirrored, the video area kept dark) and the panels as a drawer are built and in e2e. Not yet: the library with thumbnails, toasts for job progress, and the contrast and keyboard review.
- [ ] **M06b.11** — **Player controls at VLC and YouTube level**:
  - **On the video:**
    - Click to play or pause, with the centre icon animating.
    - Double-click the left or right third to seek 10 s back or forward. Each further tap adds 10 s, and a ripple shows the running total (−10, −20, −30…).
    - Double-click the middle for fullscreen.
    - Press and hold the right half to play at 2× while held.
    - The mouse wheel changes the volume.
  - **Control bar** (hides itself): play/pause, ∓10 s, volume and mute, elapsed or remaining time, speed (0.25–4×), a captions menu (on/off, track, bilingual, delay, style), picture-in-picture and fullscreen. The seek bar shows the time and a frame preview on hover, buffered ranges, and cue markers.
  - **Keyboard:**
    - Space/K play/pause; J/L ∓10 s; ←/→ ∓5 s; Shift+←/→ ∓1 min
    - ↑/↓ volume; M mute; F fullscreen; I picture-in-picture
    - 0–9 jump to 0–90 %; Home/End start and end
    - `,` / `.` step one frame while paused
    - `<` / `>` or `[` / `]` speed; `=` normal speed
    - C captions on/off; V next caption track; B bilingual; G/H caption delay ∓50 ms
    - A sets A–B loop points; S saves a screenshot to PNG
    - N/P next and previous file; ? shows the shortcut sheet
    - No shortcut fires while typing.
  - **Remembered:** position per file (with a resume prompt), volume and speed.
  - **Queue:** drop several files or a folder, and it plays them in order.
  - _Accept:_ every binding covered by a test; the shortcut sheet lists exactly the live bindings.
  - _Progress (2026-09-29):_ built ([Spec 04 §3](../../specification/04-Player-App.md#3-playback)); the keymap unit-tested binding by binding, the sheet generated from it, and the Player e2e plays with keys, taps and the queue.

### Release

- [ ] **M06b.12** — **Release contents**: the GitHub release carries `install.sh`, the engine and Player archive, the extension zip and `SHA256SUMS`. The release workflow builds all of them (and the prebuilt runtimes), and `install.sh` fetches from the release matching its version. INSTALL.md is rewritten around "run `install.sh`, then load the extension".
  - _Accept:_ `e2e/checkpoint/packaged.mjs` runs the install-script path end to end.
- [ ] **M06b.13** — **Website on GitHub Pages** (`site/`, static):
  - what sublight does, with a short demo clip and screenshots
  - features, and how it works (local and private, with the diagram)
  - install steps (the script, then Developer mode, with screenshots), and download buttons for the latest release
  - supported sites and limits (DRM, logins), privacy, FAQ, license
  - deployed by a Pages workflow from `master`
  - _Accept:_ live at the repository's Pages address; Lighthouse ≥ 90 in every category; links checked in CI.
- [ ] **M06b.14** — **Logo**: the word **sub** with a small glint of light in the subscript position, as in x₁. The subscript _is_ the light, so it reads "sub" + "light", and it sits under the text as a caption does. Deliverables:
  - an SVG wordmark in colour and in mono
  - the glint alone as the icon (16/32/48/128 px, legible at 16)
  - a favicon, and the extension icon in on and off states to show the engine state (M06b.6)
  - used across the extension, Player, website and release
  - _Accept:_ the icons are crisp on light and dark toolbars.

### Gate

- [ ] **M06b.15** — **Pre-beta audits closed**: every P0–P2 from [code quality Q-3](../../audits/2026-09-Code-Quality-Q3.md) and [security pass 2](../../audits/2026-09-Security-Baseline-Pass-2.md) fixed, and the P3s fixed or scheduled. Security is re-checked after the native host (M06b.3) and `install.sh` (M06b.2).
- [ ] **M06b.16** — **Re-run the Beta-1 matrix** on the install-script path (Chromium and Brave), including the rows I check by hand (T1, T3, T9). Then close the [Beta-1 checkpoint](../../checkpoints/Beta-1-Checklist.md) and release 0.1.0.

## Acceptance criteria

1. On a fresh user account, I run `install.sh` and load the extension. I then caption a YouTube video, the vinovo embed and a local file without another terminal command, token or pairing step.
2. The engine is off when nothing needs it and starts by itself when something does. The popup always shows which.
3. Nothing needs the Options page. The Player opens from the popup.
4. The Player has every control in M06b.11, in both themes.
5. The website is live and links the release. The release contains `install.sh`, the archive, the extension zip and checksums.
6. Both audits are closed.

## Dependencies

- [M06](06-Beta-Release.md) (done except its release).
- Pulls part of [M07.4](07-Polish-Editing.md) forward (engine status, cache and model management), into the popup.

## Open questions

- GPU runtimes: prebuilt Vulkan as the default on NVIDIA (smaller, no CUDA libraries) or CUDA? Measure both on the T1000 first.
- macOS: the same script (with a LaunchAgent and the macOS host paths) at Beta 1, or Linux first?

## Related

- [Beta-1 checkpoint](../../checkpoints/Beta-1-Checklist.md) · [M06](06-Beta-Release.md) · [M07](07-Polish-Editing.md) · [Roadmap](../Roadmap.md)
