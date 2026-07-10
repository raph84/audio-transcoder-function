import { spawn } from "node:child_process";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { TransientError } from "./errors.js";

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
 * We spawn ffprobe directly (rather than using fluent-ffmpeg's ffprobe()
 * helper) so this function holds the process handle. fluent-ffmpeg's static
 * ffprobe() helper spawns internally and never exposes the child process, so
 * if the GCS read stream errors mid-probe there'd be no way to stop it —
 * `.pipe()` doesn't end the destination on a source 'error', so ffprobe
 * would block on stdin forever, orphaned in a container Cloud Functions may
 * reuse for later invocations. Holding the handle lets us kill it.
 *
 * @param {import('stream').Readable} readStream
 * @returns {Promise<{ codec: string, sampleRate: number, channels: number }>}
 */
export function probeAudio(readStream) {
	return new Promise((resolve, reject) => {
		let settled = false;

		function settle(err, value) {
			if (settled) return;
			settled = true;
			readStream.removeListener("error", onStreamError);
			if (err) reject(err);
			else resolve(value);
		}

		const ffprobeProc = spawn(
			ffprobeInstaller.path,
			["-print_format", "json", "-show_streams", "pipe:0"],
			{ windowsHide: true },
		);

		function onStreamError(err) {
			ffprobeProc.kill("SIGKILL");
			settle(new TransientError(`source read stream error: ${err.message}`));
		}

		readStream.on("error", onStreamError);

		// ffprobe often closes its own stdin once it has read enough of the
		// header (before the source stream ends), which would otherwise raise
		// EPIPE/ECONNRESET here — expected, not a failure. Node's pipe()
		// already unpipes readStream once ffprobeProc.stdin closes.
		ffprobeProc.stdin.on("error", () => {});
		readStream.pipe(ffprobeProc.stdin);

		let stdout = "";
		let stderr = "";
		ffprobeProc.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		ffprobeProc.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		ffprobeProc.on("error", (err) => {
			settle(new Error(`ffprobe failed to start: ${err.message}`));
		});

		ffprobeProc.on("close", (code, signal) => {
			if (code !== 0) {
				const detail = stderr ? `\nstderr: ${stderr.slice(-500)}` : "";
				return settle(
					new Error(
						`ffprobe exited with code ${code}${signal ? ` (signal ${signal})` : ""}${detail}`,
					),
				);
			}

			let data;
			try {
				data = JSON.parse(stdout);
			} catch (parseErr) {
				return settle(
					new Error(`ffprobe produced invalid output: ${parseErr.message}`),
				);
			}

			const audioStream = (data.streams ?? []).find(
				(s) => s.codec_type === "audio",
			);

			if (!audioStream) {
				return settle(new Error("No audio stream found in source file"));
			}

			settle(null, {
				codec: audioStream.codec_name,
				sampleRate: Number(audioStream.sample_rate),
				channels: audioStream.channels,
			});
		});
	});
}
