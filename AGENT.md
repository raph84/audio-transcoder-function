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
  and decides which errors to rethrow (for Eventarc retry) vs. swallow.
- `src/config.js` — reads and validates environment variables at import
  time. Throws immediately on an unsupported `OUTPUT_FORMAT`.
- `src/ffmpeg.js` — wires `fluent-ffmpeg` to the static `ffmpeg`/`ffprobe`
  binaries bundled via `ffmpeg-static` / `@ffprobe-installer/ffprobe`.
- `src/probe.js` — streams the source file through `ffprobe` to detect
  codec, sample rate, channel count, and duration without buffering the
  file.
- `src/transcode.js` — streams the source file through `ffmpeg` into a
  writable stream, producing mono FLAC at the original sample rate.
- `src/silence.js` — runs a decode-only `silencedetect` pass to find quiet
  intervals, and the pure algorithm that picks silence-aware split points
  near each `SPLIT_AFTER_MINUTES` boundary.
- `src/split.js` — cuts one FLAC segment via a signed-URL-based ffmpeg seek
  + stream copy, used only when splitting is enabled.
- `src/ffmpegPipeline.js` — shared "pipe an ffmpeg command into a writable
  stream and settle a promise once" helper used by `src/transcode.js`,
  `src/silence.js`, and `src/split.js`.

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
  and the `ffprobe`/`ffmpeg` calls — they don't touch real GCS or spawn
  real ffmpeg processes. Keep it that way so `pnpm test` stays fast and
  offline.
- Streaming is a core design constraint: the function never downloads a
  full file to disk or buffers it fully in memory. New code touching
  `index.js`, `src/probe.js`, or `src/transcode.js` should preserve this.
- Errors that Eventarc should retry (transient failures) must be thrown
  from the `cloudEvent` handler. Errors that are permanent and would just
  retry forever (like the non-faststart `moov atom not found` case) must
  be logged and swallowed instead — see `index.js` for the existing
  pattern before adding new error branches.

## Gotchas

- Non-faststart M4A files (moov atom at the end) can't be decoded from a
  non-seekable stdin pipe; `ffmpeg` fails with "moov atom not found". This
  is a known, permanent limitation, not a bug to "fix" by buffering — see
  the comments in `src/probe.js` and `src/transcode.js`.
- Only `flac` is currently a supported `OUTPUT_FORMAT`; `src/config.js`
  enforces this at startup.
- `ffprobe`'s `format.duration` (used for `durationSeconds` in `src/probe.js`)
  can come back as `"N/A"` or be missing entirely for unusual encoders;
  this resolves to `durationSeconds: null` rather than throwing, since an
  unknown duration should only disable the split feature, not fail the
  whole invocation.
- `src/split.js` seeks into the already-uploaded FLAC via a signed URL,
  relying on the bundled `ffmpeg-static` binary supporting the `https`
  input protocol (`<binary> -protocols | grep https` to verify — confirmed
  supported as of the `ffmpeg-static@5.3.0` build in use, but re-check if
  that dependency is ever bumped to a different upstream build).
- The intermediate full FLAC (from `src/transcode.js`) is written via a
  non-seekable GCS write stream, so it very likely has no seek table.
  `src/split.js`'s seeks into it are still correct (ffmpeg's flac demuxer
  scans for sync codes regardless) but are an O(bytes-before-target) scan,
  not an O(1) indexed seek — a performance characteristic for later parts
  of very long recordings, not a correctness bug.
- Splitting requires the runtime service account to have
  `roles/iam.serviceAccountTokenCreator` on itself (for `getSignedUrl()`
  under Application Default Credentials) — see DEVELOPMENT.md. Without it,
  the full transcode still succeeds but no split parts are ever produced.
