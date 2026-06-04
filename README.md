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
npm run prepare:tools
```

The app checks for `auto-editor`, `ffmpeg`, `ffprobe`, and `whisper.cpp` and shows missing engines in the sidebar.

`npm run prepare:tools` prepares bundled macOS arm64 tools in `src-tauri/binaries/tools`:

- `auto-editor` is built from `WyattBlue/auto-editor` tag `30.4.0` with a local Nim toolchain and static FFmpeg libraries.
- `ffmpeg` is copied from `ffmpeg-static` `5.3.0`.
- `ffprobe` is copied from `@ffprobe-installer/ffprobe` `2.1.2`.

The generated binaries are ignored by git. `npm run tauri build` runs `prepare:tools` before packaging, so the `.app` and `.dmg` include the required video engines.

Tool lookup order:

- bundled app executable directory;
- bundled `Resources/` and `Resources/tools/`;
- project `tools/`;
- project `src-tauri/binaries/`;
- project `src-tauri/binaries/tools/`;
- user `PATH`.

For local packaging, generated executables are placed in:

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
npm run prepare:tools
npm run tauri dev
```

For frontend-only preview:

```sh
npm run dev
```

## Notes

The project pins early Tauri 2 in `src-tauri/Cargo.toml` and keeps the early runtime stack in `Cargo.lock` to avoid the newer `objc2-foundation 0.3.x` dependency path:

- `tauri = 2.0.0`
- default Tauri features disabled
- `wry` enabled explicitly
- `tauri-runtime = 2.0.0` via lockfile
- `tauri-runtime-wry = 2.0.0` via lockfile
- `tauri-utils = 2.0.0` via lockfile

Bundled tool licensing matters for distribution:

- auto-editor is Unlicense.
- the prepared FFmpeg libraries used by auto-editor reported LGPL v3 or later in the local build.
- `ffmpeg-static` reports GPL-3.0-or-later.
- `@ffprobe-installer/ffprobe` reports LGPL-2.1.
