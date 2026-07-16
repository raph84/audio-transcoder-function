import ffmpeg from "./ffmpeg.js";
import { runFfmpegPipeline } from "./ffmpegPipeline.js";

/**
 * Stream-copy one segment of an already-uploaded FLAC file, read via a
 * short-lived signed HTTPS URL (ffmpeg seeks using HTTP range requests), and
 * pipe the result directly into `outputStream` - no local disk.
 *
 * Command shape (when start > 0 and end is finite):
 *   ffmpeg -ss <start> -i <signedUrl> -c copy -t <end-start> -f flac pipe:1
 * For the final, open-ended segment (`end === null`), no duration-limiting
 * option is passed and ffmpeg decodes to EOF.
 *
 * `-ss` is applied as an input option (fast seek, before -i) for
 * performance. The segment length is expressed with `-t <duration>` rather
 * than an output-side `-to <end>`, since combining an input `-ss` with an
 * output `-to` has been ambiguous across ffmpeg versions (relative to the
 * original vs. the seeked timeline); `-t` sidesteps that entirely.
 *
 * Known limitations (see also probe.js/transcode.js for the moov-atom
 * limitation this repo documents in the same style):
 *  - `-ss` as an input option seeks to the nearest FLAC frame boundary, not
 *    an exact sample - at most tens of milliseconds, irrelevant here since
 *    cut points are chosen to land inside a detected silence interval.
 *  - The intermediate full FLAC (produced by transcode.js) is piped into a
 *    non-seekable GCS write stream, so it likely has no seek table. Seeking
 *    into it via a signed URL is still correct (ffmpeg's flac demuxer
 *    locates frames by sync-code scanning regardless) but is an
 *    O(bytes-before-target) scan rather than an O(1) indexed seek - a
 *    performance characteristic for later parts of long recordings, not a
 *    correctness bug.
 *
 * @param {string} signedUrl
 * @param {import('stream').Writable} outputStream
 * @param {{ start: number, end: number|null }} segment
 * @returns {Promise<void>}
 */
export function cutFlacSegment(signedUrl, outputStream, { start, end }) {
	const command = ffmpeg(signedUrl);
	if (start > 0) command.seekInput(start);

	const outputOptions = ["-c", "copy"];
	if (end !== null) outputOptions.push("-t", String(end - start));
	command.outputOptions(outputOptions).format("flac");

	command.on("start", (cmdLine) => {
		console.log(JSON.stringify({ msg: "split ffmpeg started", cmd: cmdLine }));
	});

	return runFfmpegPipeline(command, outputStream, {
		commandErrorLabel: "split ffmpeg",
		streamErrorLabel: "GCS write stream",
	});
}
