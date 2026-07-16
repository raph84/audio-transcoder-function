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
 * `format.duration` is normally populated from the MP4 `mvhd` atom, which
 * faststart M4A keeps at the front of the file - same reason codec/sample
 * rate detection already works over a pipe. It can still come back as "N/A"
 * or be absent for unusual encoders; `Number("N/A")` is NaN, so this
 * deliberately resolves to `durationSeconds: null` rather than throwing -
 * an unknown duration must never fail the whole invocation, it should just
 * disable the downstream split feature for that file.
 *
 * @param {import('stream').Readable} readStream
 * @returns {Promise<{ codec: string, sampleRate: number, channels: number, durationSeconds: number|null }>}
 */
export function probeAudio(readStream) {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(readStream, (err, data) => {
			if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

			const audioStream = (data.streams ?? []).find(
				(s) => s.codec_type === "audio",
			);

			if (!audioStream) {
				return reject(new Error("No audio stream found in source file"));
			}

			const parsedDuration = Number(data.format?.duration);

			resolve({
				codec: audioStream.codec_name,
				sampleRate: Number(audioStream.sample_rate),
				channels: audioStream.channels,
				durationSeconds: Number.isFinite(parsedDuration)
					? parsedDuration
					: null,
			});
		});
	});
}
