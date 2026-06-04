# VideoCleaner

Local macOS batch video cleaner MVP.

## Stack

- Tauri 2 app shell
- React + Vite frontend
- Rust commands for local job orchestration
- SQLite for persisted settings and queue state
- `auto-editor` CLI for silence cutting
- optional `whisper.cpp` CLI for SRT, TXT, and JSON transcript artifacts

## Current MVP

- Drag video files into the app window.
- Choose cut preset and output options.
- Process queued files sequentially through `auto-editor`.
- Optionally generate SRT, TXT, and JSON transcript outputs through `whisper.cpp`.
- Write cleaned videos to `~/Documents/VideoCleaner/Outputs`.
- Create `VideoCleaner-results.zip` next to the output folder.
- Open outputs in Finder.
- Restore settings and the queue after reopening through a local SQLite database.

Subtitle/transcript outputs require a local or bundled `whisper.cpp` binary and model.

## Requirements

```sh
npm install
python3 -m pip install auto-editor
```

`auto-editor` usually installs or expects FFmpeg support. The app checks for `auto-editor`, `ffmpeg`, `ffprobe`, and `whisper.cpp` and shows missing engines in the sidebar.

Tool lookup order:

- bundled app executable directory;
- bundled `Resources/` and `Resources/tools/`;
- project `tools/`;
- project `src-tauri/binaries/`;
- project `src-tauri/binaries/tools/`;
- user `PATH`.

For local packaging, place executables in:

```text
src-tauri/binaries/tools/auto-editor
src-tauri/binaries/tools/ffmpeg
src-tauri/binaries/tools/ffprobe
src-tauri/binaries/tools/whisper-cli
```

`tauri.conf.json` copies `src-tauri/binaries/tools` into app resources as `tools/`,
`src-tauri/binaries/models` as `models/`, and `src-tauri/binaries/whisper` as `whisper/`.

For whisper.cpp transcription, place a model in one of:

```text
models/ggml-base.bin
src-tauri/binaries/models/ggml-base.bin
src-tauri/binaries/whisper/models/ggml-base.bin
```

## Development

```sh
npm run build
npm run tauri dev
```

For frontend-only preview:

```sh
npm run dev
```

## Notes

The current local environment kills Tauri macOS binding dependencies such as `objc2-foundation` / `objc2-app-kit` with `SIGKILL` during `cargo check`, before reaching this app's Rust code. The frontend build is verified. Backend verification needs a Tauri/Rust environment that can compile the macOS webview dependency tree.

The project pins early Tauri 2 in `src-tauri/Cargo.toml` and keeps the early runtime stack in `Cargo.lock` to avoid the newer `objc2-foundation 0.3.x` dependency path:

- `tauri = 2.0.0`
- default Tauri features disabled
- `wry` enabled explicitly
- `tauri-runtime = 2.0.0` via lockfile
- `tauri-runtime-wry = 2.0.0` via lockfile
- `tauri-utils = 2.0.0` via lockfile
