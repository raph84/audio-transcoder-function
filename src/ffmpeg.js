import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/**
 * Build the ffmpeg command shared by transcode.js and split.js: decode
 * `inputStream` to mono FLAC at `sampleRate`, compression level 8. Callers
 * layer their own extras (e.g. split.js's seekInput/-t, or each caller's own
 * runFfmpegPipeline error labels) on top of the returned command.
 *
 * @param {import('stream').Readable} inputStream
 * @param {number} sampleRate
 * @returns {import('fluent-ffmpeg').FfmpegCommand}
 */
export function buildFlacCommand(inputStream, sampleRate) {
	return ffmpeg(inputStream)
		.audioCodec("flac")
		.audioChannels(1)
		.audioFrequency(sampleRate)
		.format("flac")
		.outputOptions(["-compression_level 8"]);
}

export default ffmpeg;
