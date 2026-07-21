# Development

## Prerequisites

- Node.js >= 24, matching the `nodejs24` Cloud Functions runtime (a dev
  container with Node 24 is provided in `.devcontainer/`)
- [pnpm](https://pnpm.io/) — pinned via `packageManager` in `package.json`
  (currently `pnpm@10.32.1`)

## Setup

```bash
pnpm install
```

`ffmpeg-static` and `@ffprobe-installer/ffprobe` install prebuilt `ffmpeg`
and `ffprobe` binaries for the current platform — no system packages
required.

## Running locally

The function runs under the
[Functions Framework](https://github.com/GoogleCloudPlatform/functions-framework-nodejs),
which emulates the Cloud Functions/Eventarc runtime locally:

```bash
pnpm start
```

This starts an HTTP server that accepts CloudEvents on `/` for the
`transcodeAudio` entry point (declared in `index.js`). To exercise it,
POST a `google.cloud.storage.object.v1.finalized` CloudEvent payload with a
real `bucket`/`name` pointing at an object the function's credentials can
read (i.e. you need valid Application Default Credentials for GCS access —
this is not fully mocked locally).

## Testing

Tests use [Vitest](https://vitest.dev/) and mock GCS, `ffprobe`, and
`ffmpeg`, so they run fully offline:

```bash
pnpm test
```

Test files sit next to the modules they cover (`index.test.js`,
`src/*.test.js`).

## Linting and formatting

This repo uses [Biome](https://biomejs.dev/) for both linting and
formatting (tabs, double quotes — see `biome.json`):

```bash
pnpm lint      # lint only
pnpm format    # format, writing changes
pnpm check     # lint + format + import organization, writing changes
```

A Husky `pre-commit` hook runs `lint-staged`, which runs `biome check --write`
on staged files automatically.

## Project structure

```
index.js            Cloud Function entry point (transcodeAudio)
src/config.js        Environment-variable configuration, validated at import time
src/ffmpeg.js         fluent-ffmpeg instance wired to the static ffmpeg/ffprobe binaries
src/probe.js          Streams a source file through ffprobe to detect codec/rate/channels/duration
src/transcode.js      Streams a source file through ffmpeg into a FLAC output stream
src/silence.js         Silencedetect pass + silence-aware split point selection
src/split.js           Transcodes one segment of the source directly to FLAC (fresh read + ffmpeg seek)
```

## Deploying

Copy `.env.example` to `.env` and fill in the values, then:

```bash
set -a; source .env; set +a

gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --runtime=nodejs24 \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --source=. \
  --entry-point=transcodeAudio \
  --trigger-event-filters="type=google.cloud.storage.object.v1.finalized" \
  --trigger-event-filters="bucket=$TRIGGER_BUCKET" \
  --trigger-location="$REGION" \
  --memory="$MEMORY" \
  --timeout="$TIMEOUT" \
  --service-account="$SERVICE_ACCOUNT" \
  --set-env-vars="SOURCE_PREFIX=$SOURCE_PREFIX,OUTPUT_PREFIX=$OUTPUT_PREFIX,OUTPUT_FORMAT=$OUTPUT_FORMAT$( [ -n "$OUTPUT_BUCKET" ] && echo ",OUTPUT_BUCKET=$OUTPUT_BUCKET" )$( [ -n "$SPLIT_AFTER_MINUTES" ] && echo ",SPLIT_AFTER_MINUTES=$SPLIT_AFTER_MINUTES,SILENCE_NOISE_DB=$SILENCE_NOISE_DB,SILENCE_MIN_DURATION_SECONDS=$SILENCE_MIN_DURATION_SECONDS$( [ -n "$SILENCE_LOOKBACK_MAX_SECONDS" ] && echo ",SILENCE_LOOKBACK_MAX_SECONDS=$SILENCE_LOOKBACK_MAX_SECONDS" )$( [ -n "$SPLIT_PART_CONCURRENCY" ] && echo ",SPLIT_PART_CONCURRENCY=$SPLIT_PART_CONCURRENCY" )" )"
```

The runtime service account needs read access to the trigger bucket and
write access to the output bucket (Storage Object Viewer / Object Admin, or
equivalent custom roles).

The deploy command intentionally omits `--retry`. For 2nd gen (Eventarc-triggered)
functions, retries are opt-in: without `--retry`, a failed invocation — including
one that hits the `--timeout` deadline — is logged and the event is dropped
rather than redelivered. Passing `--retry` would make Eventarc redeliver the
event with exponential backoff for up to 24 hours, which is undesirable here
since a timeout is likely to just recur on redelivery.

### Splitting: no extra IAM grant needed

If you set `SPLIT_AFTER_MINUTES`, each part is produced by re-reading the
*source* object directly (same read path as probe/transcode/silencedetect)
and transcoding that segment straight to FLAC — no signed URL is generated
and ffmpeg never fetches anything over HTTPS itself. The runtime service
account only needs the read/write access already described above — nothing
extra to grant.

Also consider raising `TIMEOUT` beyond the default `300s` when splitting is
enabled for long recordings: the whole invocation (probe + transcode +
silencedetect + part transcodes) has to fit inside one Cloud Functions Gen2
invocation, which supports up to `3600s`. Splitting costs real CPU — each
part re-decodes the source from byte 0 through its own cut point — so budget
timeout/CPU accordingly for recordings with many parts. Part transcodes run
concurrently but capped at `SPLIT_PART_CONCURRENCY` (default `4`) rather than
all at once, since each part is CPU-bound; raise it only if the runtime has
CPU/memory headroom for more simultaneous decodes.

## Dependency updates

Dependabot is configured (`.github/dependabot.yml`) to open weekly grouped PRs
for npm dependencies and devcontainer updates.
