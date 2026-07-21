import { classifyGcsStreamError } from "./errors.js";
import { buildFlacCommand } from "./ffmpeg.js";
import { runFfmpegPipeline } from "./ffmpegPipeline.js";

/**
 * Transcode a readable M4A stream to FLAC, writing directly to a writable stream.
 *
 * Streaming pipeline:
 *   inputStream → ffmpeg stdin → [FLAC encoder] → ffmpeg stdout → outputStream
 *
 * The Promise resolves only after outputStream emits "finish", meaning the GCS
 * HTTP upload has fully completed — not just when ffmpeg exits.
 *
 * Audio settings (built by `buildFlacCommand` in ffmpeg.js, shared with
 * split.js) follow GCP Speech-to-Text best practices:
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
	const command = buildFlacCommand(inputStream, sampleRate);

	command.on("start", (cmdLine) => {
		console.log(JSON.stringify({ msg: "ffmpeg started", cmd: cmdLine }));
	});

	// { end: true } (set inside runFfmpegPipeline) ensures ffmpeg closing stdout
	// triggers outputStream.end(), which flushes the GCS upload and eventually
	// emits "finish".
	return runFfmpegPipeline(command, outputStream, {
		commandErrorLabel: "ffmpeg",
		streamErrorLabel: "GCS write stream",
		classifyStreamError: classifyGcsStreamError,
	});
}
