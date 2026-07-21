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
2. **Check faststart.** A small leading slice of the object is read to
   determine whether its `moov` atom (the index ffmpeg needs) comes before
   or after `mdat` (the audio data). Most modern recorders (iOS, Android)
   write faststart M4A (`moov` first) by default — for these, the file is
   read directly from GCS via streaming for every later step. If it isn't
   faststart, or the check is inconclusive, the whole object is downloaded
   to a local temp file first (see below for why).
3. **Probe.** `ffprobe` detects the audio codec, sample rate, and channel
   count — reading directly from GCS without downloading the whole file
   first (faststart), or from the local temp file (non-faststart).
4. **Transcode.** `ffmpeg` encodes the source to FLAC (compression level 8)
   and pipes the result directly into a GCS write stream. Audio is downmixed
   to mono and kept at the original sample rate (never upsampled), matching
   Speech-to-Text best practices.
5. **Write.** The FLAC output is uploaded to
   `OUTPUT_PREFIX + <relative path of source, without extension> + .flac`, in
   `OUTPUT_BUCKET` if set, otherwise back in the source bucket.
6. **Split (optional).** If `PART_LENGTH_SECONDS` is set and the source's
   duration — measured from step 4's actual decode progress, not probed
   container metadata (see below) — exceeds it, the source is additionally
   re-transcoded into overlapping parts: one full ffmpeg pass per part, from
   a fresh read of the source, never a slice of the full FLAC produced in
   step 5. Parts start at `0, (PART_LENGTH_SECONDS - PART_OVERLAP_SECONDS),
   2 * (PART_LENGTH_SECONDS - PART_OVERLAP_SECONDS), ...`; each is
   `PART_LENGTH_SECONDS` long except the last, which is clipped to the
   source's actual duration. Parts are named
   `OUTPUT_PREFIX + <stem> + .partNNN.flac` (zero-padded, 1-based) alongside
   the full output. The full, unsplit output is always produced regardless
   of whether `PART_LENGTH_SECONDS` is set or splitting fails.

Duration for splitting decisions is deliberately *not* read from `ffprobe`
(step 3) or any other container header metadata — that's proven unreliable
for some of the files this function processes. Instead it's measured from
`ffmpeg`'s own progress reporting while producing the full transcode in step
4, reflecting the audio actually decoded. This is also why splitting always
runs after, and depends on, a successful full transcode.

Everything is streamed end-to-end (GCS → ffprobe/ffmpeg → GCS) for faststart
files — the function never buffers these fully in memory or on local disk.
Non-faststart files are the one exception: `ffmpeg` needs to rewind to the
start of the audio data once it locates a trailing `moov` atom, which isn't
possible on a non-seekable pipe (confirmed — there's no ffmpeg flag or
protocol wrapper that works around this), so those are downloaded to a local
temp file first, giving `ffmpeg` genuine random access.

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
  audio stream, or invalid probed metadata. Retrying can't fix any of these,
  since the problem is the file itself, not the environment.

See `src/errors.js` (`TransientError` / `isTransientError`) for the
classification mechanism.

Split-part failures (step 5 above) are an exception to this: they are always
logged and swallowed, transient or not, and processing stops before
attempting further parts. By the time a part runs, the full transcode has
already succeeded and is the important artifact — retrying the whole event
just to redo one part isn't worth it.

### Configuration

Runtime behavior is controlled by environment variables, read in
`src/config.js`:

| Variable               | Default            | Description                                                     |
| ---------------------- | ------------------ | ----------------------------------------------------------------- |
| `SOURCE_PREFIX`        | `source/`          | Object path prefix that triggers transcoding                    |
| `OUTPUT_PREFIX`        | `transcoded/`      | Object path prefix for the transcoded output                    |
| `OUTPUT_FORMAT`        | `flac`             | Output format (currently only `flac` is supported)               |
| `OUTPUT_BUCKET`        | source bucket      | Destination bucket, if different from the source                |
| `PART_LENGTH_SECONDS`  | unset (no splitting) | Max length in seconds of each split part; unset disables splitting |
| `PART_OVERLAP_SECONDS` | `0`                | Overlap in seconds between consecutive parts; must be less than `PART_LENGTH_SECONDS` |

See `.env.example` for the full set of variables, including deployment-time
settings (project, region, trigger bucket, memory, timeout).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for local setup, testing, linting, and
deployment instructions.
