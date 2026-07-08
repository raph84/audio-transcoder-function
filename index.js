import path from "node:path";
import { cloudEvent } from "@google-cloud/functions-framework";
import { Storage } from "@google-cloud/storage";
import {
	OUTPUT_BUCKET,
	OUTPUT_FORMAT,
	OUTPUT_PREFIX,
	SOURCE_PREFIX,
} from "./src/config.js";
import { prepareInputSource } from "./src/inputSource.js";
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
	const { fastStart, openProbeInput, openTranscodeInput, cleanup } =
		await prepareInputSource(sourceFile);

	if (fastStart !== true) {
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
			console.error(
				JSON.stringify({ msg: "probe failed", name, error: err.message }),
			);
			throw err;
		} finally {
			probeInput.destroy?.();
		}

		if (!Number.isFinite(audioProps.sampleRate) || audioProps.sampleRate <= 0) {
			throw new Error(
				`probe returned invalid sampleRate: ${audioProps.sampleRate}`,
			);
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

		try {
			await transcodeToFlac(transcodeInput, gcsWriteStream, audioProps);
		} catch (err) {
			const isPermanent = err.message?.includes("moov atom not found");
			console.error(
				JSON.stringify({
					msg: isPermanent
						? "transcode failed: non-faststart M4A, skipping"
						: "transcode failed",
					sourceFile: name,
					outputFile: outputName,
					error: err.message,
				}),
			);
			if (!isPermanent) throw err;
			return;
		}

		console.log(
			JSON.stringify({
				msg: "transcode complete",
				outputBucket: outputBucketName,
				outputFile: outputName,
			}),
		);
	} finally {
		await cleanup();
	}
});
