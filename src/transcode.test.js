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

	it("pipes to the output stream with { end: true }", () => {
		const out = makeOutputStream();
		transcodeToFlac(makeInputStream(), out, { sampleRate: 44100 });
		expect(state.pipeStream).toBe(out);
		expect(state.pipeOpts).toEqual({ end: true });
	});

	it("resolves when the output stream emits finish", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		out.emit("finish");

		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects when the ffmpeg command emits an error", async () => {
		const out = makeOutputStream();
		const promise = transcodeToFlac(makeInputStream(), out, {
			sampleRate: 44100,
		});

		state.handlers.error(new Error("moov atom not found"), "", "stderr text");

		await expect(promise).rejects.toThrow("ffmpeg error: moov atom not found");
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
