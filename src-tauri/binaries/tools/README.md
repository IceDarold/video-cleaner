# Bundled Tools

Place local processing binaries here when preparing a packaged app.

Expected executable names for the MVP:

- `auto-editor`
- `ffmpeg`
- `ffprobe`
- `whisper-cli` or `whisper` or `main`

During bundling, this directory is copied into the app resources as `tools/`.
At runtime VideoCleaner checks bundled resources before falling back to the user's `PATH`.
