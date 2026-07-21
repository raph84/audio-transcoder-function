import path from "node:path";
import { cloudEvent } from "@google-cloud/functions-framework";
import { Storage } from "@google-cloud/storage";
import {
	OUTPUT_BUCKET,
	OUTPUT_FORMAT,
	OUTPUT_PREFIX,
	PART_LENGTH_SECONDS,
	PART_OVERLAP_SECONDS,
	SOURCE_PREFIX,
} from "./src/config.js";
import { isTransientError } from "./src/errors.js";
import { prepareInputSource } from "./src/inputSource.js";
import { computeParts } from "./src/parts.js";
import { probeAudio } from "./src/probe.js";
import { transcodeToFlac } from "./src/transcode.js";

const storage = new Storage();

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

// Unlike handleStageError, part failures never trigger an Eventarc retry:
// the full transcode is the important artifact and has already succeeded by
// the time parts run, so redoing the whole event just to retry one part
// isn't worth it. Always log and let the caller stop attempting further parts.
function logPartError(err, fields) {
	const transient = isTransientError(err);
	console.error(
		JSON.stringify({
			msg: `part transcode failed: ${transient ? "transient" : "permanent"}, skipping remaining parts`,
			...fields,
			error: err.message,
		}),
	);
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

	let inputSource;
	try {
		inputSource = await prepareInputSource(sourceFile);
	} catch (err) {
		handleStageError(err, "prepare input", { name });
		return;
	}

	const { fastStart, openProbeInput, openTranscodeInput, cleanup } =
		inputSource;

	if (fastStart !== true) {
		// Non-faststart (or inconclusive) M4A can't be demuxed from a
		// non-seekable pipe — prepareInputSource has already downloaded it to
		// a local temp file instead; openProbeInput/openTranscodeInput below
		// return that path rather than a fresh GCS stream. See
		// src/inputSource.js.
		console.log(
			JSON.stringify({
				msg: "non-faststart M4A (or inconclusive check): using local temp file",
				name,
				fastStart,
			}),
		);
	}

	try {
		const probeInput = openProbeInput();

		let audioProps;
		try {
			audioProps = await probeAudio(probeInput);
		} catch (err) {
			handleStageError(err, "probe", { name });
			return;
		} finally {
			probeInput.destroy?.();
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

		const transcodeInput = openTranscodeInput();

		const gcsWriteStream = storage
			.bucket(outputBucketName)
			.file(outputName)
			.createWriteStream({
				resumable: false,
				metadata: { contentType: "audio/flac" },
			});

		let fullTranscodeResult;
		try {
			fullTranscodeResult = await transcodeToFlac(
				transcodeInput,
				gcsWriteStream,
				{ sampleRate: audioProps.sampleRate },
			);
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

		if (PART_LENGTH_SECONDS === null) return;

		// Duration is measured from the full transcode's own decode progress
		// (see transcodeToFlac) rather than probed from container header
		// metadata, which has proven unreliable for some source files.
		const { duration } = fullTranscodeResult;

		if (!Number.isFinite(duration) || duration <= 0) {
			console.error(
				JSON.stringify({
					msg: "skip splitting: could not measure duration from the full transcode",
					name,
					duration,
				}),
			);
			return;
		}

		const parts = computeParts(
			duration,
			PART_LENGTH_SECONDS,
			PART_OVERLAP_SECONDS,
		);

		if (parts.length === 0) {
			console.log(
				JSON.stringify({
					msg: "skip splitting: duration does not exceed PART_LENGTH_SECONDS",
					name,
					duration,
					PART_LENGTH_SECONDS,
				}),
			);
			return;
		}

		console.log(
			JSON.stringify({
				msg: "splitting into parts",
				name,
				partCount: parts.length,
			}),
		);

		for (let i = 0; i < parts.length; i++) {
			const { start, duration: partDuration } = parts[i];
			const partNumber = i + 1;
			const partName = `${OUTPUT_PREFIX}${stem}.part${String(partNumber).padStart(3, "0")}.${OUTPUT_FORMAT}`;

			const partInput = openTranscodeInput();
			const partWriteStream = storage
				.bucket(outputBucketName)
				.file(partName)
				.createWriteStream({
					resumable: false,
					metadata: { contentType: "audio/flac" },
				});

			try {
				await transcodeToFlac(partInput, partWriteStream, {
					sampleRate: audioProps.sampleRate,
					startTime: start,
					duration: partDuration,
				});
			} catch (err) {
				logPartError(err, {
					sourceFile: name,
					outputFile: partName,
					partNumber,
				});
				break;
			} finally {
				// -t (duration) makes ffmpeg stop reading stdin once it reaches the
				// part's cutoff, which for every non-final part is before a fresh
				// GCS read stream reaches EOF on its own (faststart case; a no-op
				// for the non-faststart local-file-path case). pipe() doesn't
				// destroy the source when the destination stops reading, so it
				// must be done explicitly here (mirrors probeInput above) or it
				// leaks.
				partInput.destroy?.();
			}

			console.log(
				JSON.stringify({
					msg: "part transcode complete",
					outputBucket: outputBucketName,
					outputFile: partName,
					partNumber,
					partCount: parts.length,
				}),
			);
		}
	} finally {
		await cleanup();
	}
});
