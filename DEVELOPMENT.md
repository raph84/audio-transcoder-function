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
`transcodeAudio` entry point (declared in `index.js`). It talks to real GCS
— none of this is mocked locally (that's what `pnpm test` is for) — so you
need valid Application Default Credentials for GCS access:

```bash
gcloud auth application-default login
```

If your ADC impersonates a service account (`gcloud auth application-default
login --impersonate-service-account=...`), your own account needs
`roles/iam.serviceAccountTokenCreator` on that service account, or GCS calls
will fail with `PERMISSION_DENIED: unable to impersonate`.

To exercise the function, POST a `google.cloud.storage.object.v1.finalized`
CloudEvent to it with a real `bucket`/`name` pointing at an object the above
credentials can read:

```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/cloudevents+json" \
  -d '{
    "specversion": "1.0",
    "id": "local-test-1",
    "source": "//storage.googleapis.com/projects/_/buckets/YOUR_BUCKET",
    "type": "google.cloud.storage.object.v1.finalized",
    "time": "2026-01-01T00:00:00.000Z",
    "datacontenttype": "application/json",
    "data": {
      "bucket": "YOUR_BUCKET",
      "name": "source/your-file.m4a"
    }
  }'
```

A successful invocation responds `204` with an empty body; check the
server's stdout for the structured JSON log lines (`starting transcode`,
`probe complete`, `transcode complete`, etc.) to see what actually happened.

Environment variables from `.env` (see Deploying, below) apply here too —
`source`/`set -a` it before `pnpm start` if you want non-default
`SOURCE_PREFIX`/`OUTPUT_PREFIX`/`PART_LENGTH_SECONDS`/etc. locally.

### If the invocation just hangs

In some local/sandboxed environments (seen in a containerized dev
environment with broken outbound IPv6 and no real GCE metadata server —
may not apply to yours), the request can hang indefinitely before any of
the function's own log lines appear, for two independent reasons:

- Node resolves `storage.googleapis.com`/`oauth2.googleapis.com` and tries
  an IPv6 address first, which silently blackholes instead of failing fast.
  Fix: `NODE_OPTIONS=--dns-result-order=ipv4first pnpm start`.
- `google-auth-library` falls back to probing the GCE instance metadata
  server (`169.254.169.254`) to resolve a project ID when it can't find one
  another way — this repo's `.env` sets `PROJECT_ID`, which is a name this
  repo invented for its own use, not something the auth library looks for.
  On non-GCE machines that address just blackholes rather than refusing the
  connection, so this hangs far longer than you'd expect. Fix: export
  `GOOGLE_CLOUD_PROJECT` (the standard env var name) set to your project ID.

If you hit this, both fixes together look like:

```bash
set -a; source .env; set +a
NODE_OPTIONS=--dns-result-order=ipv4first GOOGLE_CLOUD_PROJECT="$PROJECT_ID" pnpm start
```

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
src/mp4.js            Pure MP4 box-order check (isFastStart) — moov vs. mdat
src/inputSource.js    Faststart check + local-temp-file fallback for non-faststart M4A
src/probe.js          Runs ffprobe (stream or local file) to detect codec/rate/channels
src/transcode.js      Runs ffmpeg (stream or local file) into a FLAC output stream
src/parts.js          Pure segment math (computeParts) for splitting into overlapping parts
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
  --set-env-vars="SOURCE_PREFIX=$SOURCE_PREFIX,OUTPUT_PREFIX=$OUTPUT_PREFIX,OUTPUT_FORMAT=$OUTPUT_FORMAT$( [ -n "$OUTPUT_BUCKET" ] && echo ",OUTPUT_BUCKET=$OUTPUT_BUCKET" )$( [ -n "$PART_LENGTH_SECONDS" ] && echo ",PART_LENGTH_SECONDS=$PART_LENGTH_SECONDS" )$( [ -n "$PART_OVERLAP_SECONDS" ] && echo ",PART_OVERLAP_SECONDS=$PART_OVERLAP_SECONDS" )"
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

## Dependency updates

Dependabot is configured (`.github/dependabot.yml`) to open weekly grouped PRs
for npm dependencies and devcontainer updates.
