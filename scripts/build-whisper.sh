#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/.build"
WHISPER_VERSION="v1.8.4"
WHISPER_SRC="$BUILD_DIR/whisper.cpp-src"
WHISPER_DIR="$ROOT/src-tauri/binaries/whisper"
MODEL_DIR="$WHISPER_DIR/models"
MODEL_FILE="${WHISPER_MODEL:-ggml-tiny.bin}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"

mkdir -p "$BUILD_DIR" "$WHISPER_DIR" "$MODEL_DIR"

if [[ ! -d "$WHISPER_SRC/.git" ]]; then
  rm -rf "$WHISPER_SRC"
  git clone --depth 1 --branch "$WHISPER_VERSION" \
    https://github.com/ggml-org/whisper.cpp.git \
    "$WHISPER_SRC"
fi

if [[ ! -s "$MODEL_DIR/$MODEL_FILE" ]]; then
  curl -L --fail --retry 3 -C - \
    -o "$MODEL_DIR/$MODEL_FILE.tmp" \
    "$MODEL_URL"
  mv "$MODEL_DIR/$MODEL_FILE.tmp" "$MODEL_DIR/$MODEL_FILE"
fi

cmake -S "$WHISPER_SRC" -B "$WHISPER_SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON

cmake --build "$WHISPER_SRC/build" --config Release --target whisper-cli -j "$(sysctl -n hw.ncpu)"

WHISPER_BIN="$(find "$WHISPER_SRC/build" -type f -name whisper-cli -perm -111 | head -n 1)"
if [[ -z "$WHISPER_BIN" ]]; then
  echo "whisper-cli build output was not found" >&2
  exit 1
fi

cp "$WHISPER_BIN" "$WHISPER_DIR/whisper-cli"
chmod 755 "$WHISPER_DIR/whisper-cli"
