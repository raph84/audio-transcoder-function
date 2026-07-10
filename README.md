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

Everything is streamed end-to-end (GCS → ffprobe/ffmpeg → GCS) — the function
never buffers a full file in memory or on local disk.

### Error handling

Only errors classified as **transient** are re-thrown, which signals
Eventarc to retry the event; everything else is logged and swallowed so a
file that will never succeed isn't retried forever.

- **Transient (retried):** failures reading from or writing to Cloud
  Storage — e.g. a dropped connection mid-stream, or a 5xx/429 response.
  These are typically infrastructure hiccups that a retry can resolve.
  A GCS write failure with a 4xx status that indicates a persistent
  problem (bad auth, missing bucket) is treated as permanent instead,
  since retrying can't fix a misconfiguration.
- **Permanent (not retried):** anything about the audio conversion process
  itself — ffprobe/ffmpeg decode failures, unsupported codecs, a missing
  audio stream, invalid probed metadata, or the `moov atom not found`
  error raised by ffmpeg when it gets a non-faststart M4A (moov atom at
  the end of the file) on a non-seekable pipe. Retrying can't fix any of
  these, since the problem is the file itself, not the environment. Most
  modern recorders (iOS, Android) write faststart M4A by default.

See `src/errors.js` (`TransientError` / `isTransientError`) for the
classification mechanism.

### Configuration

Runtime behavior is controlled by environment variables, read in
`src/config.js`:

| Variable        | Default        | Description                                          |
| ---------------- | -------------- | ----------------------------------------------------- |
| `SOURCE_PREFIX`  | `source/`      | Object path prefix that triggers transcoding          |
| `OUTPUT_PREFIX`  | `transcoded/`  | Object path prefix for the transcoded output          |
| `OUTPUT_FORMAT`  | `flac`         | Output format (currently only `flac` is supported)    |
| `OUTPUT_BUCKET`  | source bucket  | Destination bucket, if different from the source      |

See `.env.example` for the full set of variables, including deployment-time
settings (project, region, trigger bucket, memory, timeout).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for local setup, testing, linting, and
deployment instructions.
