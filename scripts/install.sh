#!/usr/bin/env bash
# sublight installer for Linux.
#
# Installs everything that runs outside the browser into ~/.sublight: the
# engine and the Player, Node when it's missing, the speech and translation
# programs, yt-dlp and the default speech model. It registers the engine with
# the browsers so the extension can start it, puts the extension in a fixed
# folder, and shows how to load it (Developer mode → Load unpacked).
#
#   bash install.sh                  install or update
#   bash install.sh --uninstall      remove sublight (asks before deleting models)
#   bash install.sh --uninstall --purge   …and delete models, cache and settings too
#
# Options:
#   --from DIR          use a release already downloaded to DIR (the archive and SHA256SUMS)
#   --version X.Y.Z     install that release instead of this script's own
#   --no-translation    skip the translator for languages other than English
#   --with-translation  install it without asking
#   --cpu               build without CUDA
#   --yes               answer yes to every question (installing system packages included)
#   --no-browser        don't open the browser's extensions page
#
# Re-running it updates in place; what is already installed is skipped.
set -euo pipefail

SUBLIGHT_VERSION="0.1.0" # set by scripts/release.mjs
# The release archive's SHA-256, written in when the release is packaged
# (scripts/package.mjs): this script then trusts only that exact archive.
ARCHIVE_SHA256=""
REPO="ABakdi/sublight"
EXTENSION_ID="ehgdbfcecgkljnpmednociabmmjemfkf"
HOST_NAME="sublight.engine"
NODE_VERSION="22.23.3"
declare -A NODE_SHA256=(
  [x64]="df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
  [arm64]="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f"
)
DEFAULT_MODEL="whisper-small"

HOME_DIR="${SUBLIGHT_HOME:-$HOME/.sublight}"
APP="$HOME_DIR/app"
EXT="$HOME_DIR/extension"
NODE_DIR="$HOME_DIR/node"
LAUNCHER="$HOME/.local/bin/sublight-engine"
BROWSER_DIRS=(
  "$HOME/.config/google-chrome"
  "$HOME/.config/chromium"
  "$HOME/.config/BraveSoftware/Brave-Browser"
  "$HOME/.config/vivaldi"
  "$HOME/.config/microsoft-edge"
)

FROM=""
TRANSLATION="ask"
CPU=""
YES=""
OPEN_BROWSER=1
UNINSTALL=""
PURGE=""

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# yes/no question; the default is the first letter of $2 (y or n).
ask() {
  local question=$1 default=$2 answer
  if [[ -n $YES ]]; then return 0; fi
  if [[ ! -r /dev/tty ]]; then [[ $default == y ]]; return; fi
  local hint="[Y/n]"
  [[ $default == n ]] && hint="[y/N]"
  read -r -p "$question $hint " answer </dev/tty || answer=""
  answer=${answer:-$default}
  [[ $answer == [yY]* ]]
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --from) FROM=${2:?--from needs a folder}; shift 2 ;;
    --version) SUBLIGHT_VERSION=${2:?--version needs a version}; shift 2 ;;
    --no-translation) TRANSLATION="no"; shift ;;
    --with-translation) TRANSLATION="yes"; shift ;;
    --cpu) CPU="--cpu"; shift ;;
    --yes | -y) YES=1; shift ;;
    --no-browser) OPEN_BROWSER=""; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ $(uname -s) == Linux ]] || die "this installer is for Linux; see INSTALL.md for other systems"
# Everything runs as you; only system packages use sudo, when asked.
[[ $EUID -ne 0 ]] || die "run this as yourself, not as root: it asks for sudo only to install system packages"
# Where sublight lives: a plain absolute folder of its own, never / or your home itself,
# and nothing the scripts it writes would misread.
case $HOME_DIR in
  /*) ;;
  *) die "SUBLIGHT_HOME must be an absolute path" ;;
esac
HOME_DIR=${HOME_DIR%/}
[[ -n $HOME_DIR && $HOME_DIR != "${HOME%/}" && $HOME_DIR != / ]] ||
  die "SUBLIGHT_HOME can't be / or your home folder itself"
[[ $HOME_DIR != *[\"\$\`\\]* && $HOME_DIR != *$'\n'* ]] ||
  die "SUBLIGHT_HOME contains characters sublight can't use in a path"
APP="$HOME_DIR/app"
EXT="$HOME_DIR/extension"
NODE_DIR="$HOME_DIR/node"
case $(uname -m) in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported processor: $(uname -m)" ;;
esac

# --- uninstall -------------------------------------------------------------

remove_host_manifests() {
  for dir in "${BROWSER_DIRS[@]}"; do
    rm -f "$dir/NativeMessagingHosts/$HOST_NAME.json"
  done
}

if [[ -n $UNINSTALL ]]; then
  # Only a folder that holds a sublight install is ever deleted.
  [[ -f $HOME_DIR/config.json || -f $APP/sublight-engine.mjs ]] ||
    die "$HOME_DIR doesn't look like a sublight install: nothing removed"
  say "Removing sublight"
  if [[ -x $LAUNCHER ]]; then
    "$LAUNCHER" stop >/dev/null 2>&1 || true
    "$LAUNCHER" autostart disable >/dev/null 2>&1 || true
  fi
  remove_host_manifests
  rm -f "$LAUNCHER"
  rm -rf "$APP" "$EXT" "$NODE_DIR" "$HOME_DIR/bin" "$HOME_DIR/src"
  # Never deleted by --yes alone: that takes --purge, or a yes typed here.
  if [[ -n $PURGE ]] || { [[ -z $YES && -r /dev/tty ]] && ask "Also delete your models, captions cache and settings in $HOME_DIR?" n; }; then
    rm -rf "$HOME_DIR"
  else
    note "kept $HOME_DIR (models, cache, settings)"
  fi
  note "In your browser's extensions page, remove the sublight extension too."
  exit 0
fi

# --- helpers ---------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

download() { # url file
  if have curl; then
    curl -fL --retry 3 --progress-bar -o "$2" "$1"
  elif have wget; then
    wget -q --show-progress -O "$2" "$1"
  else
    die "curl or wget is needed to download sublight"
  fi
}

sha256() { sha256sum "$1" | cut -d' ' -f1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- system packages -------------------------------------------------------

# nvcc from a CUDA toolkit, where the engine's setup looks for it.
have_nvcc() { have nvcc || [[ -x /opt/cuda/bin/nvcc ]]; }

# An NVIDIA GPU with its driver running (nvidia-smi answers): CUDA can use it.
GPU=""
detect_gpu() {
  [[ -n $CPU ]] && return
  if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
    GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    GPU=${GPU:-NVIDIA GPU}
  elif have lspci && lspci 2>/dev/null | grep -qi 'vga.*nvidia\|3d.*nvidia'; then
    note "An NVIDIA graphics card is here, but its driver isn't running: install the NVIDIA driver"
    note "and run this again to use it. Using the processor (CPU) for now."
  fi
}

# Packages this machine is missing, named for its package manager.
missing_packages() {
  local pm=$1 need=()
  # The GPU needs the CUDA toolkit to build the speech and translation engines for it.
  [[ -n $GPU ]] && ! have_nvcc && need+=(cuda)
  have ffmpeg && have ffprobe || need+=(ffmpeg)
  have git || need+=(git)
  have cmake || need+=(cmake)
  have c++ || have g++ || have clang++ || need+=(compiler)
  have make || have ninja || need+=(make)
  have tar && have xz || need+=(xz)
  local out=() p
  for p in "${need[@]}"; do
    case "$pm:$p" in
      pacman:compiler | pacman:make) out+=(base-devel) ;;
      apt-get:compiler | apt-get:make) out+=(build-essential) ;;
      dnf:compiler | zypper:compiler) out+=(gcc-c++) ;;
      apt-get:xz) out+=(xz-utils) ;;
      apt-get:cuda) out+=(nvidia-cuda-toolkit) ;;
      *:compiler) out+=(g++) ;;
      *) out+=("$p") ;;
    esac
  done
  printf '%s\n' "${out[@]}" | sort -u | tr '\n' ' '
}

install_system_packages() {
  local pm="" cmd=()
  for candidate in pacman apt-get dnf zypper; do
    if have $candidate; then pm=$candidate; break; fi
  done
  # The CUDA toolkit is a package on Arch and Debian/Ubuntu; elsewhere it comes from NVIDIA.
  if [[ -n $GPU ]] && ! have_nvcc && [[ $pm != pacman && $pm != apt-get ]]; then
    note "The CUDA toolkit comes from NVIDIA's own repository on this system:"
    note "https://developer.nvidia.com/cuda-downloads (then run this again). Using the CPU for now."
    GPU=""
  fi
  local pkgs
  pkgs=$(missing_packages "${pm:-none}")
  [[ -z ${pkgs// /} ]] && return 0
  say "Needed from your system: $pkgs"
  case $pm in
    pacman) cmd=(sudo pacman -S --needed --noconfirm) ;;
    apt-get) cmd=(sudo apt-get install -y) ;;
    dnf) cmd=(sudo dnf install -y) ;;
    zypper) cmd=(sudo zypper install -y) ;;
    *) die "install these with your package manager, then run this again: $pkgs" ;;
  esac
  [[ $pm == dnf && $pkgs == *ffmpeg* ]] && note "Fedora: ffmpeg comes from RPM Fusion (https://rpmfusion.org)."
  [[ $pkgs == *cuda* ]] && note "$GPU found: the CUDA toolkit (about 4 GB) lets sublight use it."

  if ask "Install them now with: ${cmd[*]} $pkgs?" y; then
    [[ $pm == apt-get ]] && sudo apt-get update -qq
    # shellcheck disable=SC2086 # one word per package
    "${cmd[@]}" $pkgs
  else
    die "install them, then run this again: ${cmd[*]} $pkgs"
  fi
}

# --- Node ------------------------------------------------------------------

NODE=""
find_node() {
  if have node; then
    local major
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if ((major >= 22)); then NODE=$(command -v node); return; fi
  fi
  local pinned="$NODE_DIR/bin/node"
  if [[ -x $pinned ]] && [[ $("$pinned" --version) == "v$NODE_VERSION" ]]; then
    NODE=$pinned
    return
  fi
  say "Installing Node $NODE_VERSION (the engine runs on it)"
  local name="node-v$NODE_VERSION-linux-$ARCH"
  download "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" "$WORK/node.tar.xz"
  [[ $(sha256 "$WORK/node.tar.xz") == "${NODE_SHA256[$ARCH]}" ]] || die "Node's checksum doesn't match: nothing installed"
  tar -xJf "$WORK/node.tar.xz" -C "$WORK"
  rm -rf "$NODE_DIR"
  mv "$WORK/$name" "$NODE_DIR"
  NODE="$NODE_DIR/bin/node"
}

# --- the release -----------------------------------------------------------

fetch_release() {
  local archive="sublight-$SUBLIGHT_VERSION.tar.gz"
  if [[ -n $FROM ]]; then
    [[ -f $FROM/$archive && -f $FROM/SHA256SUMS ]] || die "$FROM needs $archive and SHA256SUMS"
    cp "$FROM/$archive" "$FROM/SHA256SUMS" "$WORK/"
  else
    say "Downloading sublight $SUBLIGHT_VERSION"
    local base="https://github.com/$REPO/releases/download/v$SUBLIGHT_VERSION"
    download "$base/SHA256SUMS" "$WORK/SHA256SUMS"
    download "$base/$archive" "$WORK/$archive"
  fi
  local want
  want=$(grep " $archive\$" "$WORK/SHA256SUMS" | cut -d' ' -f1)
  if [[ -n $ARCHIVE_SHA256 && -z $FROM ]]; then
    [[ $want == "$ARCHIVE_SHA256" ]] || die "SHA256SUMS doesn't match the archive this installer was released with: nothing installed"
  fi
  [[ -n $want && $(sha256 "$WORK/$archive") == "$want" ]] || die "$archive doesn't match SHA256SUMS: nothing installed"
  tar -xzf "$WORK/$archive" -C "$WORK"
  RELEASE="$WORK/sublight-$SUBLIGHT_VERSION"
  [[ -f $RELEASE/sublight-engine.mjs && -d $RELEASE/extension ]] || die "the archive is incomplete"
}

install_files() {
  say "Installing into $HOME_DIR"
  mkdir -p "$HOME_DIR"
  chmod 700 "$HOME_DIR"
  # The engine and the Player: replaced whole.
  rm -rf "$APP.new"
  mkdir -p "$APP.new"
  cp "$RELEASE/sublight-engine.mjs" "$APP.new/"
  [[ -d $RELEASE/player ]] && cp -r "$RELEASE/player" "$APP.new/player"
  cat >"$APP.new/sublight-engine" <<EOF
#!/bin/sh
SUBLIGHT_HOME="$HOME_DIR" exec "$NODE" "$APP/sublight-engine.mjs" "\$@"
EOF
  # What the browser starts when the extension asks for the engine.
  cat >"$APP.new/native-host" <<EOF
#!/bin/sh
SUBLIGHT_HOME="$HOME_DIR" exec "$NODE" "$APP/sublight-engine.mjs" native-host "\$@"
EOF
  chmod 755 "$APP.new/sublight-engine" "$APP.new/native-host"
  rm -rf "$APP.old"
  [[ -d $APP ]] && mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  rm -rf "$APP.old"

  # The extension: same folder every time, so the browser keeps it across updates.
  mkdir -p "$EXT"
  find "$EXT" -mindepth 1 -delete
  cp -r "$RELEASE/extension/." "$EXT/"

  mkdir -p "$(dirname "$LAUNCHER")"
  ln -sf "$APP/sublight-engine" "$LAUNCHER"
}

register_native_host() {
  local registered=0 dir
  for dir in "${BROWSER_DIRS[@]}"; do
    [[ -d $dir ]] || continue
    mkdir -p "$dir/NativeMessagingHosts"
    cat >"$dir/NativeMessagingHosts/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "sublight engine",
  "path": "$APP/native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
    registered=$((registered + 1))
  done
  if ((registered == 0)); then
    note "No Chrome, Chromium, Brave, Vivaldi or Edge profile found yet: run this again after starting your browser once."
  fi
}

# --- run -------------------------------------------------------------------

detect_gpu
install_system_packages
find_node
fetch_release
install_files
ENGINE="$APP/sublight-engine"
# A running older engine: stop it; the extension starts the new one when needed.
"$ENGINE" stop >/dev/null 2>&1 || true

# The GPU build when CUDA is here, else the CPU; a GPU build that fails falls back to the CPU.
setup_runtime() { # whisper | llama
  if [[ -z $CPU ]] && have_nvcc; then
    "$ENGINE" setup "$1" && return
    note "Building $1 for the GPU failed: building it for the processor (CPU) instead."
  fi
  "$ENGINE" setup "$1" --cpu
}

say "Speech recognition${GPU:+ (on the $GPU)}"
setup_runtime whisper
"$ENGINE" setup yt-dlp
"$ENGINE" model install "$DEFAULT_MODEL"

if [[ $TRANSLATION == ask ]]; then
  echo
  note "English captions work already. Captions in other languages need a translator:"
  note "llama.cpp (about 20 minutes to build) and a 2.3 GB model, fetched when first used."
  if ask "Install the translator?" y; then TRANSLATION=yes; else TRANSLATION=no; fi
fi
if [[ $TRANSLATION == yes ]]; then
  say "Translation"
  setup_runtime llama
fi

register_native_host
"$ENGINE" start --detach >/dev/null

echo
say "sublight $SUBLIGHT_VERSION is installed."
echo
echo "One last step, in your browser (once):"
echo "  1. Open the extensions page: brave://extensions or chrome://extensions"
echo "  2. Switch on Developer mode (top right)"
echo "  3. Click Load unpacked and choose: $EXT"
echo
echo "Updates: run this installer again, then click the reload arrow on sublight's card."
[[ :$PATH: == *":$HOME/.local/bin:"* ]] || note "(Add ~/.local/bin to your PATH to use the sublight-engine command.)"

if [[ -n $OPEN_BROWSER && -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]]; then
  for browser in brave brave-browser chromium chromium-browser google-chrome-stable google-chrome; do
    if have $browser; then
      page="chrome://extensions"
      [[ $browser == brave* ]] && page="brave://extensions"
      nohup "$browser" "$page" >/dev/null 2>&1 &
      break
    fi
  done
fi
