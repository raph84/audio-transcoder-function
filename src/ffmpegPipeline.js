import { TransientError } from "./errors.js";

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
 * fluent-ffmpeg forwards errors from the piped-in input stream as a command
 * `error` event with an `err.inputStreamError` marker, and errors from
 * `outputStream` itself with an `err.outputStreamError` marker (see
 * `node_modules/fluent-ffmpeg/lib/processor.js`), distinguishing them from
 * genuine ffmpeg/codec failures. If `classifyStreamError` is given, it's
 * used to classify these (and direct `outputStream` "error" events) instead
 * of the generic `${streamErrorLabel} error: ...` wrapping - callers that
 * need to distinguish transient (retryable) from permanent stream failures,
 * like transcode.js, pass `classifyGcsStreamError` here. Source read stream
 * errors are always treated as transient, since a dropped read is a network
 * hiccup rather than a property of the file. Callers that don't need this
 * distinction (silence.js, split.js) omit it and keep the original generic
 * wrapping for every command error.
 *
 * @param {import('fluent-ffmpeg').FfmpegCommand} command
 * @param {import('stream').Writable} outputStream
 * @param {{ commandErrorLabel: string, streamErrorLabel: string, classifyStreamError?: (err: Error, prefix: string) => Error }} labels
 * @returns {Promise<void>}
 */
export function runFfmpegPipeline(
	command,
	outputStream,
	{ commandErrorLabel, streamErrorLabel, classifyStreamError },
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

		function wrapOutputStreamError(err) {
			return classifyStreamError
				? classifyStreamError(err, `${streamErrorLabel} error`)
				: new Error(`${streamErrorLabel} error: ${err.message}`);
		}

		command.on("error", (err, _stdout, stderr) => {
			if (classifyStreamError && err.inputStreamError) {
				return settle(
					new TransientError(
						`source read stream error: ${err.inputStreamError.message}`,
					),
				);
			}
			if (classifyStreamError && err.outputStreamError) {
				return settle(wrapOutputStreamError(err.outputStreamError));
			}
			const detail = stderr ? `\nstderr: ${stderr.slice(-500)}` : "";
			settle(new Error(`${commandErrorLabel} error: ${err.message}${detail}`));
		});

		outputStream.on("finish", () => settle());
		outputStream.on("error", (err) => settle(wrapOutputStreamError(err)));

		command.pipe(outputStream, { end: true });
	});
}
