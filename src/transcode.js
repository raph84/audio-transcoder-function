import { classifyGcsStreamError, TransientError } from "./errors.js";
import ffmpeg from "./ffmpeg.js";

// Parses ffmpeg progress timemarks ("mm:ss.xx" or "hh:mm:ss.xx") into
// seconds. Each successive component (hours, then minutes, then seconds) is
// folded in with `total * 60 + component`, which works regardless of
// whether the timemark has 2 or 3 colon-separated parts.
function timemarkToSeconds(timemark) {
	return timemark
		.split(":")
		.reduce((total, part) => total * 60 + Number(part), 0);
}

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
 * When `startTime`/`duration` are given, ffmpeg is additionally passed `-ss`
 * (input-side seek) and `-t` (output-side cutoff), extracting a single time
 * range for split-part transcodes while reusing the same decoder/encoder
 * settings as a full transcode. On the non-seekable GCS pipe input, `-ss`
 * performs decode-and-discard rather than a fast keyframe seek — fine for
 * audio, but means an N-part split costs roughly N decode passes.
 *
 * The resolved value's `duration` is the source's actual decoded length in
 * seconds, measured from ffmpeg's own progress reporting (the timemark of
 * the last "progress" event) rather than from container header metadata —
 * the latter (as read by ffprobe) is unreliable for some of the files this
 * function processes. It's `undefined` if no progress event was observed
 * (e.g. a clip too short to produce one).
 *
 * @param {import('stream').Readable} inputStream
 * @param {import('stream').Writable} outputStream
 * @param {{ sampleRate: number, startTime?: number, duration?: number }} audioProps
 * @returns {Promise<{ duration: number | undefined }>}
 */
export function transcodeToFlac(
	inputStream,
	outputStream,
	{ sampleRate, startTime, duration },
) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let measuredDuration;
		function settle(err) {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve({ duration: measuredDuration });
		}

		const command = ffmpeg(inputStream)
			.audioCodec("flac")
			.audioChannels(1)
			.audioFrequency(sampleRate)
			.format("flac")
			.outputOptions(["-compression_level 8"]);

		if (startTime !== undefined) command.seekInput(startTime);
		if (duration !== undefined) command.duration(duration);

		command.on("start", (cmdLine) => {
			console.log(JSON.stringify({ msg: "ffmpeg started", cmd: cmdLine }));
		});

		command.on("progress", (progress) => {
			if (progress.timemark) {
				measuredDuration = timemarkToSeconds(progress.timemark);
			}
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
