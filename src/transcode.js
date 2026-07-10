import { classifyGcsStreamError, TransientError } from "./errors.js";
import ffmpeg from "./ffmpeg.js";

/**
 * Transcode a readable M4A stream to FLAC, writing directly to a writable stream.
 *
 * Streaming pipeline:
 *   inputStream → ffmpeg stdin → [FLAC encoder] → ffmpeg stdout → outputStream
 *
 * The Promise resolves only after outputStream emits "finish", meaning the GCS
 * HTTP upload has fully completed — not just when ffmpeg exits.
 *
 * Audio settings follow GCP Speech-to-Text best practices:
 *   - Mono output: the Speech API ignores the second stereo channel; mixing
 *     down beforehand avoids wasted bandwidth and potential accuracy loss.
 *   - Preserved sample rate: never upsample — passing the probed rate prevents
 *     ffmpeg from performing any resampling that would not improve quality.
 *   - FLAC compression level 8: good size/CPU tradeoff for cloud storage.
 *
 * Known limitation: Non-faststart M4A files (moov atom at end of file) cannot
 * be decoded from a non-seekable stdin pipe. ffmpeg will error with "moov atom
 * not found". Most modern recorders write faststart M4A by default.
 *
 * @param {import('stream').Readable} inputStream
 * @param {import('stream').Writable} outputStream
 * @param {{ sampleRate: number }} audioProps
 * @returns {Promise<void>}
 */
export function transcodeToFlac(inputStream, outputStream, { sampleRate }) {
	return new Promise((resolve, reject) => {
		let settled = false;
		function settle(err) {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve();
		}

		const command = ffmpeg(inputStream)
			.audioCodec("flac")
			.audioChannels(1)
			.audioFrequency(sampleRate)
			.format("flac")
			.outputOptions(["-compression_level 8"]);

		command.on("start", (cmdLine) => {
			console.log(JSON.stringify({ msg: "ffmpeg started", cmd: cmdLine }));
		});

		command.on("error", (err, _stdout, stderr) => {
			// fluent-ffmpeg wraps errors from the input/output streams themselves
			// with `inputStreamError` / `outputStreamError` markers, distinguishing
			// them from genuine ffmpeg/codec failures. The `outputStreamError`
			// check is a defense-in-depth backstop: in practice our own
			// `outputStream.on("error", ...)` listener below is registered before
			// fluent-ffmpeg attaches its internal one, so it settles first — but
			// that ordering isn't part of fluent-ffmpeg's documented contract.
			if (err.inputStreamError) {
				return settle(
					new TransientError(
						`source read stream error: ${err.inputStreamError.message}`,
					),
				);
			}
			if (err.outputStreamError) {
				return settle(
					classifyGcsStreamError(
						err.outputStreamError,
						"GCS write stream error",
					),
				);
			}
			const detail = stderr ? `\nstderr: ${stderr.slice(-500)}` : "";
			settle(new Error(`ffmpeg error: ${err.message}${detail}`));
		});

		outputStream.on("finish", () => settle(null));
		outputStream.on("error", (err) =>
			settle(classifyGcsStreamError(err, "GCS write stream error")),
		);

		// { end: true } ensures ffmpeg closing stdout triggers outputStream.end(),
		// which flushes the GCS upload and eventually emits "finish".
		command.pipe(outputStream, { end: true });
	});
}
