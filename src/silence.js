import { Writable } from "node:stream";
import ffmpeg from "./ffmpeg.js";
import { runFfmpegPipeline } from "./ffmpegPipeline.js";

const SILENCE_START_RE = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END_RE =
	/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*(-?[\d.]+)/;

/**
 * Parse `silencedetect` stderr lines into closed silence intervals.
 *
 * ffmpeg emits one line per event:
 *   [silencedetect @ 0x...] silence_start: 12.345
 *   [silencedetect @ 0x...] silence_end: 15.678 | silence_duration: 3.333
 *
 * A trailing, unmatched silence_start (silence still running when the file
 * ends) is returned separately as `danglingStart` rather than folded into
 * `intervals`, because closing it requires the file's total duration, which
 * this pure function doesn't have.
 *
 * @param {string[]} lines
 * @returns {{ intervals: Array<{start: number, end: number}>, danglingStart: number|null }}
 */
export function parseSilenceLines(lines) {
	const intervals = [];
	let pendingStart = null;

	for (const line of lines) {
		const endMatch = line.match(SILENCE_END_RE);
		if (endMatch) {
			if (pendingStart === null) {
				console.error(
					JSON.stringify({
						msg: "silence_end without matching silence_start, ignoring",
						line,
					}),
				);
				continue;
			}
			intervals.push({ start: pendingStart, end: Number(endMatch[1]) });
			pendingStart = null;
			continue;
		}

		const startMatch = line.match(SILENCE_START_RE);
		if (startMatch) {
			pendingStart = Number(startMatch[1]);
		}
	}

	return { intervals, danglingStart: pendingStart };
}

/**
 * Run a lightweight, encode-free ffmpeg pass over `readStream` to find
 * silence intervals, using the same fresh-read-stream pattern as
 * probe.js/transcode.js (never reuse a consumed GCS read stream).
 *
 * Command shape: `-af silencedetect=noise=<noiseDb>dB:d=<minDurationSeconds>
 * -f null -` - decode + filter only, no encoder, output discarded into an
 * in-memory no-op Writable (never touches GCS or local disk).
 *
 * @param {import('stream').Readable} readStream
 * @param {{ noiseDb: number, minDurationSeconds: number, durationSeconds?: number|null }} opts
 *   `durationSeconds`, if provided, closes a dangling trailing silence run
 *   (one still active at EOF) to `{ start: danglingStart, end: durationSeconds }`
 *   instead of dropping it - relevant because a split point might land near
 *   the very end of the file.
 * @returns {Promise<Array<{start: number, end: number}>>} sorted ascending by start
 */
export function detectSilence(
	readStream,
	{ noiseDb, minDurationSeconds, durationSeconds = null },
) {
	const stderrLines = [];

	const discard = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});

	const command = ffmpeg(readStream)
		.noVideo()
		.audioFilters(`silencedetect=noise=${noiseDb}dB:d=${minDurationSeconds}`)
		.outputOptions(["-f", "null"]);

	command.on("start", (cmdLine) => {
		console.log(JSON.stringify({ msg: "silencedetect started", cmd: cmdLine }));
	});

	command.on("stderr", (line) => stderrLines.push(line));

	return runFfmpegPipeline(command, discard, {
		commandErrorLabel: "silencedetect ffmpeg",
		streamErrorLabel: "silencedetect discard stream",
	}).then(() => {
		const { intervals, danglingStart } = parseSilenceLines(stderrLines);

		if (danglingStart !== null) {
			if (durationSeconds !== null) {
				intervals.push({ start: danglingStart, end: durationSeconds });
			} else {
				console.error(
					JSON.stringify({
						msg: "dangling silence_start at EOF with unknown duration, dropped",
						danglingStart,
					}),
				);
			}
		}

		intervals.sort((a, b) => a.start - b.start);
		return intervals;
	});
}

/**
 * For each boundary B = k * splitAfterSeconds (k = 1, 2, ...) while
 * B < durationSeconds, pick a cut point:
 *   1. a silence interval containing B -> cut at its midpoint
 *   2. else the nearest silence interval entirely before B, within
 *      lookbackMaxSeconds -> cut at its midpoint
 *   3. else a hard cut exactly at B (logged as a warning)
 *
 * Returns contiguous, non-overlapping segments covering [0, EOF]. The final
 * segment's `end` is `null` (open/EOF) rather than durationSeconds, so
 * callers never pass a duration-limiting option for the last part and just
 * let ffmpeg decode to end of stream - durationSeconds is ffprobe's
 * estimate, not a guaranteed exact boundary.
 *
 * Since index.js only calls this when durationSeconds > splitAfterSeconds
 * (strict >), the k=1 boundary is always < durationSeconds, so this never
 * returns a 1-element ("no cut happened") result when actually invoked -
 * it's always >= 2 segments. The []-on-below-threshold branch below is
 * defense-in-depth for direct callers (e.g. tests).
 *
 * @param {object} params
 * @param {number} params.durationSeconds
 * @param {number} params.splitAfterSeconds
 * @param {Array<{start: number, end: number}>} params.silenceIntervals sorted ascending, non-overlapping
 * @param {number} params.lookbackMaxSeconds
 * @returns {Array<{start: number, end: number|null}>}
 */
export function computeSplitPoints({
	durationSeconds,
	splitAfterSeconds,
	silenceIntervals,
	lookbackMaxSeconds,
}) {
	if (
		!Number.isFinite(durationSeconds) ||
		durationSeconds <= splitAfterSeconds
	) {
		return [];
	}

	const cutTimes = [];
	for (let k = 1; k * splitAfterSeconds < durationSeconds; k++) {
		const boundary = k * splitAfterSeconds;
		const cut = selectCutPoint(boundary, silenceIntervals, lookbackMaxSeconds);
		const prev = cutTimes[cutTimes.length - 1] ?? 0;
		if (cut > prev) cutTimes.push(cut);
		// else: collapses into/behind the previous cut (e.g. two hard-cut
		// fallbacks landing close together) - dropped to keep the list
		// strictly increasing; caller still gets a valid, if slightly
		// coarser, segment list.
	}

	const segments = [];
	let start = 0;
	for (const t of cutTimes) {
		segments.push({ start, end: t });
		start = t;
	}
	segments.push({ start, end: null });
	return segments;
}

/**
 * @param {number} boundary
 * @param {Array<{start: number, end: number}>} silenceIntervals
 * @param {number} lookbackMaxSeconds
 * @returns {number} the chosen cut time for boundary `boundary`
 */
export function selectCutPoint(boundary, silenceIntervals, lookbackMaxSeconds) {
	const containing = silenceIntervals.find(
		(iv) => iv.start <= boundary && iv.end >= boundary,
	);
	if (containing) return (containing.start + containing.end) / 2;

	let nearestBefore = null;
	for (const iv of silenceIntervals) {
		if (iv.end <= boundary && boundary - iv.end <= lookbackMaxSeconds) {
			if (!nearestBefore || iv.end > nearestBefore.end) nearestBefore = iv;
		}
	}
	if (nearestBefore) return (nearestBefore.start + nearestBefore.end) / 2;

	console.error(
		JSON.stringify({
			msg: "no silence found near split boundary, falling back to hard cut",
			boundary,
			lookbackMaxSeconds,
		}),
	);
	return boundary;
}
