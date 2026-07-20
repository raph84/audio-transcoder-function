import ffmpeg from "./ffmpeg.js";
import { runFfmpegPipeline } from "./ffmpegPipeline.js";

/**
 * Transcode one segment of the source audio straight to FLAC - decoding a
 * fresh read of the *original* source stream through ffmpeg and piping the
 * result directly into `outputStream` - no local disk, no intermediate
 * file, no re-fetch of the already-uploaded full FLAC.
 *
 * Command shape (when start > 0 and end is finite):
 *   ffmpeg -ss <start> -i pipe:0 -ac 1 -ar <sampleRate> -c:a flac
 *          -compression_level 8 -t <end-start> -f flac pipe:1
 * For the final, open-ended segment (`end === null`), no duration-limiting
 * option is passed and ffmpeg decodes to EOF. Mirrors transcode.js's
 * settings exactly so a split part is indistinguishable from the
 * corresponding slice of the full-file output.
 *
 * This previously stream-copied (`-c copy`) a segment out of the
 * already-transcoded FLAC, read via a signed HTTPS URL that ffmpeg fetched
 * itself. Two things ruled that out:
 *  - ffmpeg-static's bundled HTTPS/TLS input protocol reliably segfaults in
 *    this environment (reproduced locally against a plain HTTPS server,
 *    independent of GCP/gVisor - not an infra issue, a broken protocol
 *    handler in this static build).
 *  - Even setting that aside, `-ss` as an input option on a non-seekable
 *    source combined with `-c copy` doesn't discard leading data - it just
 *    shifts output timestamps, silently producing a segment of the wrong
 *    length/content. `-ss` only seeks correctly on a non-seekable input
 *    when ffmpeg is actually decoding (verified locally: piped stdin +
 *    real transcode produced byte-identical PCM to a direct-file
 *    baseline), which requires re-encoding rather than stream copy.
 *
 * Re-decoding the source per part (rather than cutting the encoded FLAC)
 * costs more CPU - each segment decodes from the start of the source
 * through its own cut point, same O(bytes-before-target) shape the old
 * approach already had, just spent on real audio decode instead of cheap
 * FLAC frame scanning - but it reuses the exact stdin-pipe pattern that
 * `transcode.js` and `silence.js` already rely on successfully in
 * production, and sidesteps ffmpeg's HTTPS input entirely.
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
	const command = ffmpeg(inputStream)
		.audioCodec("flac")
		.audioChannels(1)
		.audioFrequency(sampleRate)
		.format("flac")
		.outputOptions(["-compression_level 8"]);

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
