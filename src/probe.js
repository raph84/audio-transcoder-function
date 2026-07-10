import { TransientError } from "./errors.js";
import ffmpeg from "./ffmpeg.js";

/**
 * Probe a GCS read stream for audio properties using ffprobe.
 *
 * ffprobe reads the container header from the stream to detect codec,
 * sample rate, and channel count. For M4A files, this works even when the
 * moov atom is at the end of the file, because the codec info is in the
 * container header at the beginning.
 *
 * NOTE: Non-faststart M4A files (moov atom at end) will cause the subsequent
 * ffmpeg transcoding step to fail with "moov atom not found", because ffmpeg
 * cannot seek backward in a non-seekable pipe. Most modern recorders (iOS,
 * Android) write faststart M4A by default.
 *
 * fluent-ffmpeg's ffprobe() pipes readStream into ffprobe's stdin itself but
 * doesn't listen for errors on readStream, so a GCS network error would
 * otherwise just stall the probe. Listening here lets it surface as a
 * TransientError instead of an indistinguishable ffprobe decode failure.
 *
 * @param {import('stream').Readable} readStream
 * @returns {Promise<{ codec: string, sampleRate: number, channels: number }>}
 */
export function probeAudio(readStream) {
	return new Promise((resolve, reject) => {
		let settled = false;

		function settleResolve(value) {
			if (settled) return;
			settled = true;
			readStream.removeListener("error", onStreamError);
			resolve(value);
		}

		function settleReject(err) {
			if (settled) return;
			settled = true;
			readStream.removeListener("error", onStreamError);
			reject(err);
		}

		function onStreamError(err) {
			settleReject(
				new TransientError(`source read stream error: ${err.message}`),
			);
		}

		readStream.on("error", onStreamError);

		ffmpeg.ffprobe(readStream, (err, data) => {
			if (err) return settleReject(new Error(`ffprobe failed: ${err.message}`));

			const audioStream = (data.streams ?? []).find(
				(s) => s.codec_type === "audio",
			);

			if (!audioStream) {
				return settleReject(new Error("No audio stream found in source file"));
			}

			settleResolve({
				codec: audioStream.codec_name,
				sampleRate: Number(audioStream.sample_rate),
				channels: audioStream.channels,
			});
		});
	});
}
