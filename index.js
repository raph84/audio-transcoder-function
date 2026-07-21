import path from "node:path";
import { cloudEvent } from "@google-cloud/functions-framework";
import { Storage } from "@google-cloud/storage";
import { mapWithConcurrency } from "./src/concurrency.js";
import {
	OUTPUT_BUCKET,
	OUTPUT_FORMAT,
	OUTPUT_PREFIX,
	SILENCE_LOOKBACK_MAX_SECONDS,
	SILENCE_MIN_DURATION_SECONDS,
	SILENCE_NOISE_DB,
	SOURCE_PREFIX,
	SPLIT_AFTER_MINUTES,
	SPLIT_PART_CONCURRENCY,
} from "./src/config.js";
import { isTransientError } from "./src/errors.js";
import { probeAudio } from "./src/probe.js";
import { computeSplitPoints, detectSilence } from "./src/silence.js";
import { transcodeFlacSegment } from "./src/split.js";
import { transcodeToFlac } from "./src/transcode.js";

const storage = new Storage();

const splitThresholdSeconds =
	SPLIT_AFTER_MINUTES !== null ? SPLIT_AFTER_MINUTES * 60 : null;

function logError(msg, fields) {
	console.error(JSON.stringify({ msg, ...fields }));
}

function handleStageError(err, stage, fields) {
	const retry = isTransientError(err);
	console.error(
		JSON.stringify({
			msg: `${stage} failed: ${retry ? "transient, will retry" : "skipping"}`,
			...fields,
			error: err.message,
		}),
	);
	if (retry) throw err;
}

cloudEvent("transcodeAudio", async (cloudevent) => {
	const { bucket, name } = cloudevent.data ?? {};

	if (!bucket || !name) {
		console.error(JSON.stringify({ msg: "skip: malformed event data" }));
		return;
	}

	if (!name.startsWith(SOURCE_PREFIX)) {
		console.log(
			JSON.stringify({
				msg: "skip: outside source prefix",
				name,
				SOURCE_PREFIX,
			}),
		);
		return;
	}

	if (!name.toLowerCase().endsWith(".m4a")) {
		console.log(JSON.stringify({ msg: "skip: not an M4A file", name }));
		return;
	}

	const relativePath = name.slice(SOURCE_PREFIX.length);
	const ext = path.extname(relativePath);
	const stem = relativePath.slice(0, relativePath.length - ext.length);
	const outputName = `${OUTPUT_PREFIX}${stem}.${OUTPUT_FORMAT}`;
	const outputBucketName = OUTPUT_BUCKET ?? bucket;

	console.log(
		JSON.stringify({
			msg: "starting transcode",
			sourceBucket: bucket,
			sourceFile: name,
			outputBucket: outputBucketName,
			outputFile: outputName,
			outputFormat: OUTPUT_FORMAT,
		}),
	);

	const sourceFile = storage.bucket(bucket).file(name);
	const probeReadStream = sourceFile.createReadStream();

	let audioProps;
	try {
		audioProps = await probeAudio(probeReadStream);
	} catch (err) {
		handleStageError(err, "probe", { name });
		return;
	} finally {
		probeReadStream.destroy?.();
	}

	if (!Number.isFinite(audioProps.sampleRate) || audioProps.sampleRate <= 0) {
		console.error(
			JSON.stringify({
				msg: "probe returned invalid sampleRate: skipping",
				name,
				sampleRate: audioProps.sampleRate,
			}),
		);
		return;
	}

	console.log(
		JSON.stringify({
			msg: "probe complete",
			codec: audioProps.codec,
			sampleRate: audioProps.sampleRate,
			channels: audioProps.channels,
		}),
	);

	const transcodeReadStream = sourceFile.createReadStream();

	const gcsWriteStream = storage
		.bucket(outputBucketName)
		.file(outputName)
		.createWriteStream({
			resumable: false,
			metadata: { contentType: "audio/flac" },
		});

	try {
		await transcodeToFlac(transcodeReadStream, gcsWriteStream, audioProps);
	} catch (err) {
		handleStageError(err, "transcode", {
			sourceFile: name,
			outputFile: outputName,
		});
		return;
	}

	console.log(
		JSON.stringify({
			msg: "transcode complete",
			outputBucket: outputBucketName,
			outputFile: outputName,
		}),
	);

	if (splitThresholdSeconds === null) return;

	if (audioProps.durationSeconds == null) {
		console.log(
			JSON.stringify({
				msg: "skip split: duration unknown from probe",
				sourceFile: name,
			}),
		);
		return;
	}

	if (audioProps.durationSeconds <= splitThresholdSeconds) {
		console.log(
			JSON.stringify({
				msg: "skip split: duration below threshold",
				durationSeconds: audioProps.durationSeconds,
				splitThresholdSeconds,
			}),
		);
		return;
	}

	try {
		const silenceReadStream = sourceFile.createReadStream();
		let silenceIntervals;
		try {
			silenceIntervals = await detectSilence(silenceReadStream, {
				noiseDb: SILENCE_NOISE_DB,
				minDurationSeconds: SILENCE_MIN_DURATION_SECONDS,
				durationSeconds: audioProps.durationSeconds,
			});
		} finally {
			silenceReadStream.destroy?.();
		}

		const segments = computeSplitPoints({
			durationSeconds: audioProps.durationSeconds,
			splitAfterSeconds: splitThresholdSeconds,
			silenceIntervals,
			lookbackMaxSeconds: SILENCE_LOOKBACK_MAX_SECONDS,
		});

		console.log(
			JSON.stringify({
				msg: "split points computed",
				sourceFile: name,
				partCount: segments.length,
				segments,
			}),
		);

		// Parts are independent: each opens its own fresh read of the source
		// object and writes to its own output object. Each is a CPU-bound
		// ffmpeg decode of the source from byte 0 through its own cut point
		// (see split.js for why). Concurrency is capped at
		// SPLIT_PART_CONCURRENCY rather than left unbounded, so a recording
		// with many split points doesn't spin up an unbounded number of
		// simultaneous full-source decodes in one invocation; every part is
		// still attempted even if another one fails (see mapWithConcurrency).
		const partResults = await mapWithConcurrency(
			segments,
			SPLIT_PART_CONCURRENCY,
			async (segment, i) => {
				const partName = `${OUTPUT_PREFIX}${stem}.part${String(i + 1).padStart(3, "0")}.${OUTPUT_FORMAT}`;
				const partReadStream = sourceFile.createReadStream();
				const partWriteStream = storage
					.bucket(outputBucketName)
					.file(partName)
					.createWriteStream({
						resumable: false,
						metadata: { contentType: "audio/flac" },
					});

				console.log(
					JSON.stringify({
						msg: "transcoding part",
						partName,
						start: segment.start,
						end: segment.end,
					}),
				);

				try {
					await transcodeFlacSegment(
						partReadStream,
						partWriteStream,
						segment,
						audioProps,
					);
				} finally {
					partReadStream.destroy?.();
				}
			},
		);

		const firstPartFailure = partResults.find((r) => r.status === "rejected");
		if (firstPartFailure) throw firstPartFailure.reason;

		console.log(
			JSON.stringify({
				msg: "split complete",
				sourceFile: name,
				partCount: segments.length,
			}),
		);
	} catch (err) {
		// Deliberately swallowed: the primary deliverable (full FLAC) already
		// succeeded, and rethrowing would make Eventarc redeliver the whole
		// event, re-running the expensive transcode just to retry what's
		// often a transient split-phase issue. Mirrors the moov-atom
		// precedent above.
		logError("split failed; full transcode already succeeded, not retrying", {
			sourceFile: name,
			outputFile: outputName,
			error: err.message,
		});
	}
});
