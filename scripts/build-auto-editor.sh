#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/.build"
TOOLCHAIN_DIR="$BUILD_DIR/toolchains"
NIM_VERSION="2.2.10"
AUTO_EDITOR_VERSION="30.4.0"
NIM_DIR="$TOOLCHAIN_DIR/nim-$NIM_VERSION"
AUTO_EDITOR_SRC="$BUILD_DIR/auto-editor-src"
TOOLS_DIR="$ROOT/src-tauri/binaries/tools"

mkdir -p "$TOOLCHAIN_DIR" "$BUILD_DIR/nimble" "$TOOLS_DIR"

if [[ ! -x "$NIM_DIR/bin/nim" ]]; then
  archive="$TOOLCHAIN_DIR/nim-$NIM_VERSION-macosx_arm64.tar.xz"
  curl -L --fail --retry 3 \
    -o "$archive" \
    "https://nim-lang.org/download/nim-$NIM_VERSION-macosx_arm64.tar.xz"
  tar -xJf "$archive" -C "$TOOLCHAIN_DIR"
fi

if [[ ! -d "$AUTO_EDITOR_SRC/.git" ]]; then
  rm -rf "$AUTO_EDITOR_SRC"
  git clone --depth 1 --branch "$AUTO_EDITOR_VERSION" \
    https://github.com/WyattBlue/auto-editor.git \
    "$AUTO_EDITOR_SRC"
fi

export PATH="$NIM_DIR/bin:$PATH"
export NIMBLE_DIR="$BUILD_DIR/nimble"
export DISABLE_VPX=1
export DISABLE_SVTAV1=1
export DISABLE_HEVC=1
export DISABLE_WHISPER=1
export DISABLE_VPL=1

pushd "$AUTO_EDITOR_SRC" >/dev/null
if [[ ! -f build/include/libavutil/rational.h ]]; then
  nimble --nimbleDir:"$NIMBLE_DIR" makeff -y
fi
nimble --nimbleDir:"$NIMBLE_DIR" make -y
popd >/dev/null

cp "$AUTO_EDITOR_SRC/auto-editor" "$TOOLS_DIR/auto-editor"
chmod 755 "$TOOLS_DIR/auto-editor"
