/**
 * Wire a fluent-ffmpeg command's output into a writable stream, settling a
 * promise exactly once when either side finishes or errors.
 *
 * Shared by every module that runs an ffmpeg command and pipes its output
 * somewhere (transcode.js, silence.js, split.js), which all previously
 * re-implemented this same settle-once guard and error-message wrapping.
 *
 * On a command error, `outputStream` is destroyed so a partially-written
 * upload (or other resource) doesn't linger open after the promise rejects.
 *
 * @param {import('fluent-ffmpeg').FfmpegCommand} command
 * @param {import('stream').Writable} outputStream
 * @param {{ commandErrorLabel: string, streamErrorLabel: string }} labels
 * @returns {Promise<void>}
 */
export function runFfmpegPipeline(
	command,
	outputStream,
	{ commandErrorLabel, streamErrorLabel },
) {
	return new Promise((resolve, reject) => {
		let settled = false;
		function settle(err) {
			if (settled) return;
			settled = true;
			if (err) {
				outputStream.destroy?.();
				reject(err);
			} else {
				resolve();
			}
		}

		command.on("error", (err, _stdout, stderr) => {
			const detail = stderr ? `\nstderr: ${stderr.slice(-500)}` : "";
			settle(new Error(`${commandErrorLabel} error: ${err.message}${detail}`));
		});

		outputStream.on("finish", () => settle());
		outputStream.on("error", (err) =>
			settle(new Error(`${streamErrorLabel} error: ${err.message}`)),
		);

		command.pipe(outputStream, { end: true });
	});
}
