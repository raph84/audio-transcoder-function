import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buffer as streamToBuffer } from "node:stream/consumers";
import { classifyGcsStreamError } from "./errors.js";
import { isFastStart, PREFIX_BYTES } from "./mp4.js";

/**
 * Prepare the input(s) used to probe and transcode a GCS M4A object.
 *
 * Non-faststart M4A (moov atom after mdat) can't be demuxed from a
 * non-seekable pipe — ffmpeg needs to rewind to the start of `mdat` once it
 * locates `moov`, which a pipe can't do; it doesn't even fail loudly for
 * this, it silently emits a near-empty output instead of erroring. This
 * reads the object's leading bytes to check atom order and, when the file
 * is faststart, streams it directly from GCS (cheap, low memory, matches
 * the rest of this function's streaming design). Otherwise — or when the
 * check is inconclusive — it downloads the whole object to a local
 * seekable temp file first, which works regardless of atom order. This is
 * the one deliberate exception to this function's normal streaming
 * constraint: there is no seekable-pipe trick that works here (verified:
 * neither raising ffmpeg's probe/analyze buffers nor wrapping the pipe in
 * ffmpeg's own `cache:` protocol lets it rewind past data already read from
 * a true pipe), so a real, disk-backed random-access file is the only way
 * to decode these.
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

	let prefix;
	try {
		prefix = await streamToBuffer(prefixStream);
	} catch (err) {
		throw classifyGcsStreamError(err, "source read stream error");
	}

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
	try {
		await sourceFile.download({ destination: localPath });
	} catch (err) {
		throw classifyGcsStreamError(err, "source download error");
	}

	return {
		fastStart,
		openProbeInput: () => localPath,
		openTranscodeInput: () => localPath,
		cleanup: () => unlink(localPath).catch(() => {}),
	};
}
