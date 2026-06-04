# Whisper Runtime

Generated whisper.cpp assets for packaged builds live here.

`npm run prepare:tools` creates:

- `whisper-cli`
- `models/ggml-tiny.bin`

The generated binary and model are ignored by git. This directory is copied into app resources as `whisper/`.
