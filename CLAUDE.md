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
  CloudEvent: filters by path/extension, calls `prepareInputSource` to get
  probe/transcode inputs, orchestrates probe → transcode, and decides which
  errors to rethrow (for Eventarc retry) vs. swallow, based on
  `isTransientError`.
- `src/config.js` — reads and validates environment variables at import
  time. Throws immediately on an unsupported `OUTPUT_FORMAT`, an invalid
  `PART_LENGTH_SECONDS`/`PART_OVERLAP_SECONDS`, or a `PART_OVERLAP_SECONDS`
  that isn't strictly less than `PART_LENGTH_SECONDS`.
- `src/errors.js` — defines `TransientError` / `isTransientError`, the
  mechanism used to classify errors as retryable vs. permanent, plus
  `classifyGcsStreamError` for GCS read/write stream failures specifically
  (permanent for a 4xx status that indicates a persistent problem like bad
  auth or a missing bucket, transient otherwise).
- `src/ffmpeg.js` — wires `fluent-ffmpeg` to the static `ffmpeg` binary
  bundled via `ffmpeg-static`, used by `src/transcode.js`.
- `src/mp4.js` — pure function (`isFastStart`), no I/O: walks MP4 top-level
  boxes in a buffer and returns whether `moov` comes before `mdat`
  (faststart), after it (non-faststart), or `null` if inconclusive (neither
  found within the given prefix).
- `src/inputSource.js` — `prepareInputSource(sourceFile)` reads a small
  leading slice of the GCS object and runs `isFastStart` on it. Faststart:
  returns functions that open fresh GCS read streams, same as before. Not
  faststart (or inconclusive): downloads the whole object to a local temp
  file first and returns that path instead — see Gotchas for why this is
  necessary and is the one deliberate exception to the streaming rule below.
- `src/probe.js` — spawns `ffprobe` directly (bundled via
  `@ffprobe-installer/ffprobe`) to detect codec, sample rate, and channel
  count. Accepts either a stream (piped into ffprobe's stdin, without
  buffering the file) or a local file path string (passed directly as
  ffprobe's input argument — used for the non-faststart case above). Spawns
  directly rather than going through fluent-ffmpeg's `ffprobe()` helper so
  it holds the process handle — see Gotchas.
- `src/transcode.js` — runs the source (stream or local file path) through
  `ffmpeg` into a writable stream, producing mono FLAC at the original
  sample rate. Optionally accepts `startTime`/`duration` to extract a single
  time range (`-ss`/`-t`), used for split-part transcodes. Resolves with
  `{ duration }`, the source's decoded length in seconds measured from
  ffmpeg's own "progress" events — not container metadata — which
  `index.js` uses to decide whether/how to split. See Gotchas.
- `src/parts.js` — pure function (`computeParts`), no I/O: given a total
  duration, part length, and overlap, returns the sliding-window
  `{start, duration}` segments to transcode.

Each `src/*.js` module has a co-located `*.test.js`; `index.test.js` covers
the entry point's default (no-splitting) behavior, and `index.parts.test.js`
covers splitting specifically (it needs `PART_LENGTH_SECONDS` set before
`index.js`/`src/config.js` are first imported, so it can't share a module
graph with `index.test.js`).

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
  `src/inputSource.js`'s local-temp-file fallback for non-faststart M4A is
  the one deliberate, verified-necessary exception — see Gotchas — not a
  precedent for buffering elsewhere.
- Every GCS read stream you create must be explicitly `.destroy()`ed once
  you're done with it, in a `finally` block. `pipe()` only ends the
  destination when the *source* ends/errors — it never destroys the source
  when the *destination* stops reading first (an early process exit, a
  consumer error, or an output-side cutoff like ffmpeg's `-t`). Without an
  explicit destroy, that GCS read stream dangles, and since a Cloud
  Functions container can be reused across invocations, the leak persists
  past the current invocation. This isn't hypothetical: it's caused two
  separate bugs already — see the Gotchas below for `probeReadStream` and
  `partReadStream`. Any new code that opens a read stream and pipes it into
  something that might stop consuming before EOF needs the same guard.
- Error classification lives in `src/errors.js`: only errors wrapped in
  `TransientError` (currently: GCS read/write/download stream failures —
  network hiccups, not the audio content itself) are rethrown from the
  `cloudEvent` handler so Eventarc retries. Everything else — ffprobe/
  ffmpeg decode failures, unsupported codecs, missing audio streams,
  invalid probed metadata — is treated as permanent: log it and `return`
  instead of throwing, since retrying the same file would just fail
  identically forever. When adding a new failure path, decide up front
  whether it's a network/infra issue (wrap in `TransientError`) or a
  property of the file itself (don't), and check `isTransientError(err)` in
  `index.js` rather than pattern-matching on error messages.

## Gotchas

- Non-faststart M4A files (moov atom at the end) can't be decoded from a
  non-seekable stdin pipe: ffmpeg's `mov` demuxer can reach `moov` by
  reading forward through (and discarding) `mdat`, so it correctly reports
  duration/codec/stream info — but then can't rewind to actually read
  `mdat`'s sample bytes, since a pipe can't seek backward. Verified there is
  no pipe-side trick around this: neither raising ffmpeg's
  `-probesize`/`-analyzeduration`, nor wrapping the pipe in ffmpeg's own
  `cache:` protocol (which tries to seek back to the start of the cached
  stream to determine its size, and fails identically) changes the outcome.
  **Critically, ffmpeg does not fail loudly here** — it logs `Invalid data
  found when processing input`/`partial file`, still exits 0, and writes a
  near-empty output. Nothing about a thrown ffmpeg command error catches
  this, so treat "transcode complete" logged for a suspiciously tiny output
  as this failure, not a real success. `src/inputSource.js`
  (`prepareInputSource`) is the fix: it detects atom order up front via
  `src/mp4.js` and downloads non-faststart (or inconclusive) files to a
  local temp file, which is genuinely seekable, before probing/transcoding.
  Don't remove this fallback or revert to always streaming — that
  reintroduces silent data corruption for these files, not just a
  performance regression.
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
  that process handle reachable from the stream-error handler. `index.js`
  also destroys `probeReadStream` itself in a `finally` block, since
  ffprobe often closes its own stdin once it has read enough of the header,
  well before the source stream ends — see the streaming-cleanup
  convention above.
- Split-part transcodes hit the same dangling-stream hazard as the probe
  case above, from a different trigger: `-t` (output-side cutoff, see the
  `.seekInput()` gotcha below) makes ffmpeg stop reading stdin once it
  reaches the part's cutoff, which for every non-final part is before the
  GCS read stream reaches EOF on its own. `index.js` destroys each
  `partReadStream` in a `finally` block for exactly this reason. This one
  fires on the normal success path (not just on error, unlike the probe
  case), so it's easy to miss in testing if mocks don't simulate an
  early-closing consumer.
- fluent-ffmpeg's `.seekInput()` (`-ss`, input-side) on the non-seekable GCS
  pipe used for the transcode input performs decode-and-discard up to the
  seek point rather than a fast keyframe seek — fine for audio, but means
  splitting a faststart file into N parts costs roughly N decode passes, not
  1. Not a bug to fix (there's no seekable alternative for a streamed pipe
  input); just a cost characteristic to weigh against `PART_LENGTH_SECONDS`
  and the function timeout. This doesn't apply to non-faststart files: they
  already go through `src/inputSource.js`'s local temp file, which is
  genuinely seekable, so `-ss` there is a real seek, not decode-and-discard.
- `src/probe.js` deliberately does not report duration, and `index.js` does
  not use ffprobe/container metadata to decide whether to split. That
  metadata (`format.duration` or a stream's own `duration` field) has proven
  unreliable for some source files. Instead, `src/transcode.js` tracks the
  timemark of ffmpeg's own `"progress"` events during the full transcode and
  resolves with the measured `duration`; `index.js` only computes/attempts
  parts after that full transcode has succeeded, using this measured value.
  If you're tempted to reintroduce a probed/header-based duration for
  splitting, don't — that's the exact unreliability this design avoids.
