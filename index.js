import path from "node:path";
import { cloudEvent } from "@google-cloud/functions-framework";
import { Storage } from "@google-cloud/storage";
import {
	OUTPUT_BUCKET,
	OUTPUT_FORMAT,
	OUTPUT_PREFIX,
	SOURCE_PREFIX,
} from "./src/config.js";
import { isTransientError } from "./src/errors.js";
import { probeAudio } from "./src/probe.js";
import { transcodeToFlac } from "./src/transcode.js";

const storage = new Storage();

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
		const retry = isTransientError(err);
		console.error(
			JSON.stringify({
				msg: retry
					? "probe failed: transient, will retry"
					: "probe failed: skipping",
				name,
				error: err.message,
			}),
		);
		if (retry) throw err;
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
		const retry = isTransientError(err);
		console.error(
			JSON.stringify({
				msg: retry
					? "transcode failed: transient, will retry"
					: "transcode failed: skipping",
				sourceFile: name,
				outputFile: outputName,
				error: err.message,
			}),
		);
		if (retry) throw err;
		return;
	}

	console.log(
		JSON.stringify({
			msg: "transcode complete",
			outputBucket: outputBucketName,
			outputFile: outputName,
		}),
	);
});
