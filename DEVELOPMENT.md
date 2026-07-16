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
src/split.js           Cuts one FLAC segment out of a signed URL via ffmpeg seek + stream copy
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
  --set-env-vars="SOURCE_PREFIX=$SOURCE_PREFIX,OUTPUT_PREFIX=$OUTPUT_PREFIX,OUTPUT_FORMAT=$OUTPUT_FORMAT$( [ -n "$OUTPUT_BUCKET" ] && echo ",OUTPUT_BUCKET=$OUTPUT_BUCKET" )$( [ -n "$SPLIT_AFTER_MINUTES" ] && echo ",SPLIT_AFTER_MINUTES=$SPLIT_AFTER_MINUTES,SILENCE_NOISE_DB=$SILENCE_NOISE_DB,SILENCE_MIN_DURATION_SECONDS=$SILENCE_MIN_DURATION_SECONDS$( [ -n "$SILENCE_LOOKBACK_MAX_SECONDS" ] && echo ",SILENCE_LOOKBACK_MAX_SECONDS=$SILENCE_LOOKBACK_MAX_SECONDS" ) )"
```

The runtime service account needs read access to the trigger bucket and
write access to the output bucket (Storage Object Viewer / Object Admin, or
equivalent custom roles).

### Splitting: extra one-time IAM grant

If you set `SPLIT_AFTER_MINUTES`, the function generates a short-lived
signed URL for the uploaded FLAC (to seek into it for cutting parts). On
Cloud Functions Gen2 under Application Default Credentials, this requires
the runtime service account to be able to sign as itself:

```bash
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="$PROJECT_ID"
```

Without this, the full FLAC still uploads normally, but `getSignedUrl()`
fails and no split parts are ever produced (the failure is caught, logged
as `"split failed"`, and swallowed — see the README's Error handling
section).

Also consider raising `TIMEOUT` beyond the default `540s` when splitting is
enabled for long recordings: the whole invocation (probe + transcode +
silencedetect + all part uploads, cut concurrently) has to fit inside one
Cloud Functions Gen2 invocation, which supports up to `3600s`.

## Dependency updates

Dependabot is configured (`.github/dependabot.yml`) to open weekly grouped PRs
for npm dependencies and devcontainer updates.
