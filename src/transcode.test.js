import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// State shared between the vi.mock factory (hoisted) and each test.
// Reassigned in beforeEach so every test starts with a fresh command object.
const state = vi.hoisted(() => ({
	handlers: {},
	audioCodecArg: null,
	audioChannelsArg: null,
	audioFrequencyArg: null,
	formatArg: null,
	outputOptionsArg: null,
	seekInputArg: null,
	durationArg: null,
	pipeStream: null,
	pipeOpts: null,
}));

vi.mock("fluent-ffmpeg", () => {
	function buildCmd() {
		const cmd = {};
		cmd.audioCodec = (v) => {
			state.audioCodecArg = v;
			return cmd;
		};
		cmd.audioChannels = (v) => {
			state.audioChannelsArg = v;
			return cmd;
		};
		cmd.audioFrequency = (v) => {
			state.audioFrequencyArg = v;
			return cmd;
		};
		cmd.format = (v) => {
			state.formatArg = v;
			return cmd;
		};
		cmd.outputOptions = (v) => {
			state.outputOptionsArg = v;
			return cmd;
		};
		cmd.seekInput = (v) => {
			state.seekInputArg = v;
			return cmd;
		};
		cmd.duration = (v) => {
			state.durationArg = v;
			return cmd;
		};
		cmd.on = (event, handler) => {
			state.handlers[event] = handler;
			return cmd;
		};
		cmd.pipe = (stream, opts) => {
			state.pipeStream = stream;
			state.pipeOpts = opts;
			return stream;
		};
		return cmd;
	}

	const ffmpegFn = Object.assign(vi.fn(buildCmd), {
		setFfmpegPath: vi.fn(),
		setFfprobePath: vi.fn(),
	});
	return { default: ffmpegFn };
});

vi.mock("ffmpeg-static", () => ({ default: "/mock/ffmpeg" }));
vi.mock("@ffprobe-installer/ffprobe", () => ({
	default: { path: "/mock/ffprobe" },
}));

import { TransientError } from "./errors.js";
import { transcodeToFlac } from "./transcode.js";

function makeInputStream() {
	return new Readable({ read() {} });
}

function makeOutputStream() {
	return new EventEmitter();
}

describe("transcodeToFlac", () => {
	beforeEach(() => {
		Object.assign(state, {
			handlers: {},
			audioCodecArg: null,
			audioChannelsArg: null,
			audioFrequencyArg: null,
			formatArg: null,
			outputOptionsArg: null,
			seekInputArg: null,
			durationArg: null,
			pipeStream: null,
			pipeOpts: null,
		});
	});

	it("passes correct audio codec to ffmpeg", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
		});
		expect(state.audioCodecArg).toBe("flac");
	});

	it("always outputs mono (1 channel)", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
		});
		expect(state.audioChannelsArg).toBe(1);
	});

	it("sets the audio frequency to the probed sample rate", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 16000,
		});
		expect(state.audioFrequencyArg).toBe(16000);
	});

	it("sets output format to flac", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
		});
		expect(state.formatArg).toBe("flac");
	});

	it("sets compression level 8 in outputOptions", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
		});
		expect(state.outputOptionsArg).toContain("-compression_level 8");
	});

	it("does not call seekInput or duration when startTime/duration are not provided", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
		});
		expect(state.seekInputArg).toBeNull();
		expect(state.durationArg).toBeNull();
	});

	it("calls seekInput with the given startTime", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
			startTime: 105,
		});
		expect(state.seekInputArg).toBe(105);
	});

	it("supports startTime of 0", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
			startTime: 0,
		});
		expect(state.seekInputArg).toBe(0);
	});

	it("calls duration (output -t) with the given duration", () => {
		transcodeToFlac(makeInputStream(), makeOutputStream(), {
			sampleRate: 44100,
			startTime: 0,
			duration: 120,
		});
		expect(state.durationArg).toBe(120);
	});

	it("pipes to the output stream with { end: true }", () => {
		const out = makeOutputStream();
		transcodeToFlac(makeInputStream(), out, { sampleRate: 44100 });
		expect(state.pipeStream).toBe(out);
		expect(state.pipeOpts).toEqual({ end: true });
	});

	it("resolves with duration: undefined when no progress event was observed", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		out.emit("finish");

		await expect(promise).resolves.toEqual({ duration: undefined });
	});

	it("resolves with the duration measured from the last ffmpeg progress timemark", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		state.handlers.progress({ timemark: "00:01:05.50" });
		state.handlers.progress({ timemark: "00:02:10.25" });
		out.emit("finish");

		await expect(promise).resolves.toEqual({ duration: 130.25 });
	});

	it("parses an mm:ss timemark without an hours component", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		state.handlers.progress({ timemark: "01:30.00" });
		out.emit("finish");

		await expect(promise).resolves.toEqual({ duration: 90 });
	});

	it("rejects when the ffmpeg command emits an error", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		state.handlers.error(new Error("moov atom not found"), "", "stderr text");

		await expect(promise).rejects.toThrow("ffmpeg error: moov atom not found");
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("rejects with a TransientError when the input stream errors", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		// fluent-ffmpeg forwards input stream errors as a command 'error' event
		// with an `inputStreamError` marker (see lib/processor.js).
		const wrapped = new Error("Input stream error: ECONNRESET");
		wrapped.inputStreamError = new Error("ECONNRESET");
		state.handlers.error(wrapped, "", "");

		await expect(promise).rejects.toBeInstanceOf(TransientError);
		await expect(promise).rejects.toThrow(
			"source read stream error: ECONNRESET",
		);
	});

	it("includes stderr tail in the rejection message", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		state.handlers.error(new Error("codec error"), "", "detailed stderr");

		await expect(promise).rejects.toThrow("stderr: detailed stderr");
	});

	it("rejects when the output stream emits an error", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		out.emit("error", new Error("upload aborted"));

		await expect(promise).rejects.toThrow(
			"GCS write stream error: upload aborted",
		);
		await expect(promise).rejects.toBeInstanceOf(TransientError);
	});

	it("rejects with a plain (non-transient) error when the output stream error has a permanent HTTP status", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		const permissionErr = new Error("permission denied");
		permissionErr.status = 403;
		out.emit("error", permissionErr);

		await expect(promise).rejects.toThrow(
			"GCS write stream error: permission denied",
		);
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("classifies err.outputStreamError from the command 'error' event the same way as a direct output stream error", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		// fluent-ffmpeg forwards output stream errors as a command 'error' event
		// with an `outputStreamError` marker (see lib/processor.js), as a
		// defense-in-depth backstop alongside our own outputStream listener.
		const permissionErr = new Error("permission denied");
		permissionErr.status = 403;
		const wrapped = new Error("Output stream error: permission denied");
		wrapped.outputStreamError = permissionErr;
		state.handlers.error(wrapped, "", "");

		await expect(promise).rejects.toThrow(
			"GCS write stream error: permission denied",
		);
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("settles only once when both command error and stream error fire", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		state.handlers.error(new Error("ffmpeg died"), "", "");
		out.emit("error", new Error("stream also died"));

		// Promise must reject exactly once with the first error.
		await expect(promise).rejects.toThrow("ffmpeg died");
	});
});
