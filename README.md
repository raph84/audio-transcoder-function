# audio-transcoder-function

A Google Cloud Function (2nd gen) that automatically transcodes M4A audio
files to FLAC when they are uploaded to a Cloud Storage bucket. It's built to
prepare recordings for [Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text),
which recommends lossless, mono, native-sample-rate audio.

## How it works

The function is triggered by a Cloud Storage `object.finalized` event
(Eventarc) whenever a file is written to the trigger bucket.

1. **Filter.** The event is ignored unless the object path starts with
   `SOURCE_PREFIX` and the file has a `.m4a` extension (case-insensitive).
   This also prevents the function from re-triggering on its own FLAC output.
2. **Probe.** The source file is streamed from GCS into `ffprobe` to detect
   its audio codec, sample rate, and channel count, without downloading the
   whole file first.
3. **Transcode.** The source file is streamed a second time through `ffmpeg`,
   which encodes it to FLAC (compression level 8) and pipes the result
   directly into a GCS write stream. Audio is downmixed to mono and kept at
   the original sample rate (never upsampled), matching Speech-to-Text best
   practices.
4. **Write.** The FLAC output is uploaded to
   `OUTPUT_PREFIX + <relative path of source, without extension> + .flac`, in
   `OUTPUT_BUCKET` if set, otherwise back in the source bucket.
5. **Split (optional).** If `SPLIT_AFTER_MINUTES` is set and the recording's
   duration exceeds it, the function also cuts the uploaded FLAC into
   roughly-`SPLIT_AFTER_MINUTES`-long parts. Cut points are chosen at a
   nearby moment of silence — the function walks backward from each
   boundary to the closest detected silence, falling back to a hard cut
   only if none is found nearby — so a split doesn't land mid-sentence.
   Parts are uploaded alongside the full file as
   `<full file stem>.part001.flac`, `.part002.flac`, etc. This is fully
   opt-in: with `SPLIT_AFTER_MINUTES` unset, behavior is identical to the
   full-file-only pipeline above.

Everything is streamed end-to-end (GCS → ffprobe/ffmpeg → GCS) — the function
never buffers a full file in memory or on local disk. The split step is the
one exception in spirit but not in practice: rather than downloading
anything, it seeks into the already-uploaded FLAC via a short-lived signed
URL (HTTP range requests), so no local disk or extra memory is used either.

### Error handling

- Probe and transcode failures are re-thrown, which signals Eventarc to retry
  the event.
- The one exception is `moov atom not found`, raised by ffmpeg when it gets a
  non-faststart M4A (moov atom at the end of the file) on a non-seekable
  pipe. That's treated as a permanent, non-retryable failure and logged
  instead of thrown, since retrying can't fix it. Most modern recorders
  (iOS, Android) write faststart M4A by default.
- Split-phase failures (silence detection or a part upload failing) are
  logged (`"split failed"`) and swallowed, never rethrown. By the time the
  split step runs, the full FLAC has already uploaded successfully;
  rethrowing would make Eventarc redeliver the whole event and redo the
  (expensive) full transcode just to retry what's usually a transient
  split-phase issue. If splitting persistently fails (e.g. a missing IAM
  grant, see [DEVELOPMENT.md](DEVELOPMENT.md)), it will silently never
  produce parts — consider a log-based alert on `"split failed"`.

### Configuration

Runtime behavior is controlled by environment variables, read in
`src/config.js`:

| Variable                         | Default              | Description                                                          |
| --------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `SOURCE_PREFIX`                   | `source/`             | Object path prefix that triggers transcoding                           |
| `OUTPUT_PREFIX`                   | `transcoded/`         | Object path prefix for the transcoded output                           |
| `OUTPUT_FORMAT`                   | `flac`                | Output format (currently only `flac` is supported)                     |
| `OUTPUT_BUCKET`                   | source bucket         | Destination bucket, if different from the source                       |
| `SPLIT_AFTER_MINUTES`             | unset (disabled)      | Enables splitting; recordings longer than this get cut into parts      |
| `SILENCE_NOISE_DB`                | `-30`                 | `silencedetect` noise threshold (dB) used to find candidate cut points |
| `SILENCE_MIN_DURATION_SECONDS`    | `0.5`                 | Minimum quiet duration to count as silence                             |
| `SILENCE_LOOKBACK_MAX_SECONDS`    | 25% of the split interval, capped at 120s | How far back from a split boundary to search for silence before falling back to a hard cut |

See `.env.example` for the full set of variables, including deployment-time
settings (project, region, trigger bucket, memory, timeout).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for local setup, testing, linting, and
deployment instructions.
