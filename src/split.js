import { buildFlacCommand } from "./ffmpeg.js";
import { runFfmpegPipeline } from "./ffmpegPipeline.js";

/**
 * Transcode one segment of the source audio straight to FLAC - decoding a
 * fresh read of the *original* source stream through ffmpeg and piping the
 * result directly into `outputStream` - no local disk, no intermediate
 * file.
 *
 * The base command (mono FLAC at the probed sample rate, compression level
 * 8) is built by `buildFlacCommand` in ffmpeg.js, shared with
 * transcode.js's full-file command - this function layers the seek/duration
 * options on top.
 *
 * Command shape (when start > 0 and end is finite):
 *   ffmpeg -ss <start> -i pipe:0 -ac 1 -ar <sampleRate> -c:a flac
 *          -compression_level 8 -t <end-start> -f flac pipe:1
 * For the final, open-ended segment (`end === null`), no duration-limiting
 * option is passed and ffmpeg decodes to EOF. Mirrors transcode.js's
 * settings exactly so a split part is indistinguishable from the
 * corresponding slice of the full-file output.
 *
 * `inputStream` is a non-seekable stdin pipe, so `-ss` seeks by decoding
 * forward to the target timestamp rather than an indexed seek - each
 * segment is fully re-encoded rather than stream-copied. Cost scales with
 * how far into the source a segment starts: a segment near the end of a
 * long recording decodes (and discards) everything before it.
 *
 * `inputStream` must be a fresh read of the source object (each segment
 * decodes independently from byte 0), not shared or reused across calls.
 *
 * @param {import('stream').Readable} inputStream
 * @param {import('stream').Writable} outputStream
 * @param {{ start: number, end: number|null }} segment
 * @param {{ sampleRate: number }} audioProps
 * @returns {Promise<void>}
 */
export function transcodeFlacSegment(
	inputStream,
	outputStream,
	{ start, end },
	{ sampleRate },
) {
	const command = buildFlacCommand(inputStream, sampleRate);

	if (start > 0) command.seekInput(start);
	if (end !== null) command.outputOptions(["-t", String(end - start)]);

	command.on("start", (cmdLine) => {
		console.log(JSON.stringify({ msg: "split ffmpeg started", cmd: cmdLine }));
	});

	return runFfmpegPipeline(command, outputStream, {
		commandErrorLabel: "split ffmpeg",
		streamErrorLabel: "GCS write stream",
	});
}
