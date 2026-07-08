import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buffer as streamToBuffer } from "node:stream/consumers";
import { isFastStart, PREFIX_BYTES } from "./mp4.js";

/**
 * Prepare the input(s) used to probe and transcode a GCS M4A object.
 *
 * Non-faststart M4A (moov atom after mdat) can't be demuxed from a
 * non-seekable pipe — ffmpeg silently emits an empty output instead of
 * erroring. This reads the object's leading bytes to check atom order and,
 * when the file is faststart, streams it directly from GCS (cheap, low
 * memory). Otherwise — or when the check is inconclusive — it downloads the
 * object to a local seekable temp file first, which works regardless of
 * atom order.
 *
 * @param {import('@google-cloud/storage').File} sourceFile
 * @returns {Promise<{
 *   fastStart: boolean|null,
 *   openProbeInput: () => (import('stream').Readable|string),
 *   openTranscodeInput: () => (import('stream').Readable|string),
 *   cleanup: () => Promise<void>,
 * }>}
 */
export async function prepareInputSource(sourceFile) {
	const prefixStream = sourceFile.createReadStream({
		start: 0,
		end: PREFIX_BYTES - 1,
	});
	const prefix = await streamToBuffer(prefixStream);
	const fastStart = isFastStart(prefix);

	if (fastStart === true) {
		return {
			fastStart,
			openProbeInput: () => sourceFile.createReadStream(),
			openTranscodeInput: () => sourceFile.createReadStream(),
			cleanup: async () => {},
		};
	}

	const localPath = path.join(os.tmpdir(), `${randomUUID()}.m4a`);
	await sourceFile.download({ destination: localPath });

	return {
		fastStart,
		openProbeInput: () => localPath,
		openTranscodeInput: () => localPath,
		cleanup: () => unlink(localPath).catch(() => {}),
	};
}
