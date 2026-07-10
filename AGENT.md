# AGENT.md

This file gives guidance to coding agents (Claude Code and similar tools)
working in this repository.

## What this repo is

A Google Cloud Function (2nd gen, Node.js, CloudEvent-triggered) that
transcodes M4A audio files to FLAC when they land in a Cloud Storage bucket,
as a preprocessing step for GCP Speech-to-Text. See `README.md` for the
full behavior and `DEVELOPMENT.md` for setup/testing/deploy commands.

## Commands

```bash
pnpm install     # install dependencies
pnpm start       # run locally via the Functions Framework
pnpm test        # run the Vitest suite (mocked, offline)
pnpm lint        # Biome lint
pnpm format      # Biome format (writes)
pnpm check       # Biome lint + format + organize imports (writes)
```

Always run `pnpm check` and `pnpm test` before considering a change done.

## Code layout

- `index.js` — the function entry point (`transcodeAudio`). Handles the
  CloudEvent: filters by path/extension, orchestrates probe → transcode,
  and decides which errors to rethrow (for Eventarc retry) vs. swallow,
  based on `isTransientError`.
- `src/config.js` — reads and validates environment variables at import
  time. Throws immediately on an unsupported `OUTPUT_FORMAT`.
- `src/errors.js` — defines `TransientError` / `isTransientError`, the
  mechanism used to classify errors as retryable vs. permanent, plus
  `classifyGcsStreamError` for GCS read/write stream failures specifically
  (permanent for a 4xx status that indicates a persistent problem like bad
  auth or a missing bucket, transient otherwise).
- `src/ffmpeg.js` — wires `fluent-ffmpeg` to the static `ffmpeg` binary
  bundled via `ffmpeg-static`, used by `src/transcode.js`.
- `src/probe.js` — spawns `ffprobe` directly (bundled via
  `@ffprobe-installer/ffprobe`) and streams the source file into its stdin
  to detect codec, sample rate, and channel count without buffering the
  file. Spawns directly rather than going through fluent-ffmpeg's
  `ffprobe()` helper so it holds the process handle — see Gotchas.
- `src/transcode.js` — streams the source file through `ffmpeg` into a
  writable stream, producing mono FLAC at the original sample rate.

Each `src/*.js` module has a co-located `*.test.js`; `index.test.js` covers
the entry point.

## Conventions

- ES modules (`"type": "module"` in `package.json`), Node >= 24 (matches the
  `nodejs24` Cloud Functions runtime).
- Formatting/linting is Biome-owned: tabs, double quotes, organized imports.
  Don't hand-format — run `pnpm check` instead of manually matching style.
- Structured logging: log lines are `console.log`/`console.error` with a
  single JSON object (`{ msg, ...fields }`). Keep new log lines in this
  shape rather than free-form strings.
- Tests mock `@google-cloud/storage`, `@google-cloud/functions-framework`,
  `node:child_process` (for `src/probe.js`), and `fluent-ffmpeg` (for
  `src/transcode.js`) — they don't touch real GCS or spawn real
  ffprobe/ffmpeg processes. Keep it that way so `pnpm test` stays fast and
  offline.
- Streaming is a core design constraint: the function never downloads a
  full file to disk or buffers it fully in memory. New code touching
  `index.js`, `src/probe.js`, or `src/transcode.js` should preserve this.
- Error classification lives in `src/errors.js`: only errors wrapped in
  `TransientError` (currently: GCS read/write stream failures — network
  hiccups, not the audio content itself) are rethrown from the
  `cloudEvent` handler so Eventarc retries. Everything else — ffprobe/
  ffmpeg decode failures, unsupported codecs, missing audio streams,
  invalid probed metadata, the non-faststart `moov atom not found` case —
  is treated as permanent: log it and `return` instead of throwing, since
  retrying the same file would just fail identically forever. When adding
  a new failure path, decide up front whether it's a network/infra issue
  (wrap in `TransientError`) or a property of the file itself (don't), and
  check `isTransientError(err)` in `index.js` rather than pattern-matching
  on error messages.

## Gotchas

- Non-faststart M4A files (moov atom at the end) can't be decoded from a
  non-seekable stdin pipe; `ffmpeg` fails with "moov atom not found". This
  is a known, permanent limitation, not a bug to "fix" by buffering — see
  the comments in `src/probe.js` and `src/transcode.js`.
- Only `flac` is currently a supported `OUTPUT_FORMAT`; `src/config.js`
  enforces this at startup.
- fluent-ffmpeg pipes the GCS read stream into ffmpeg's stdin internally
  for the transcode command, and forwards input-stream errors as a command
  `error` event with an `err.inputStreamError` marker, and output-stream
  errors with an `err.outputStreamError` marker (see
  `node_modules/fluent-ffmpeg/lib/processor.js`); `src/transcode.js`
  checks both to classify the error correctly.
- `src/probe.js` spawns `ffprobe` itself instead of using fluent-ffmpeg's
  static `ffprobe()` helper. That helper spawns the process internally and
  never exposes a handle to it — confirmed by testing that if the GCS read
  stream errors mid-probe, `.pipe()` does not end the destination on a
  source `'error'`, so the orphaned ffprobe process would block on stdin
  forever rather than exiting. Spawning directly lets `src/probe.js` call
  `.kill()` on that exact failure path. If you touch `src/probe.js`, keep
  that process handle reachable from the stream-error handler.
