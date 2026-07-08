# audio-transcoder-function
Function to transcode audio files

## Deploy

Copy `.env.example` to `.env` and fill in the values, then:

```bash
set -a; source .env; set +a

gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --runtime=nodejs20 \
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
  --set-env-vars="SOURCE_PREFIX=$SOURCE_PREFIX,OUTPUT_PREFIX=$OUTPUT_PREFIX,OUTPUT_FORMAT=$OUTPUT_FORMAT$( [ -n "$OUTPUT_BUCKET" ] && echo ",OUTPUT_BUCKET=$OUTPUT_BUCKET" )"
```
