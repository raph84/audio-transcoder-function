import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// State shared between the vi.mock factory (hoisted) and each test.
const state = vi.hoisted(() => ({
	inputArg: null,
	seekInputArg: null,
	audioCodecArg: null,
	audioChannelsArg: null,
	audioFrequencyArg: null,
	formatArg: null,
	outputOptionsArg: [],
	handlers: {},
	pipeStream: null,
	pipeOpts: null,
}));

vi.mock("fluent-ffmpeg", () => {
	function buildCmd(input) {
		state.inputArg = input;
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
		cmd.seekInput = (v) => {
			state.seekInputArg = v;
			return cmd;
		};
		cmd.outputOptions = (v) => {
			state.outputOptionsArg.push(...v);
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

import { transcodeFlacSegment } from "./split.js";

function makeInputStream() {
	return new Readable({ read() {} });
}

function makeOutputStream() {
	return new EventEmitter();
}

const AUDIO_PROPS = { sampleRate: 44100 };

describe("transcodeFlacSegment", () => {
	beforeEach(() => {
		Object.assign(state, {
			inputArg: null,
			seekInputArg: null,
			audioCodecArg: null,
			audioChannelsArg: null,
			audioFrequencyArg: null,
			formatArg: null,
			outputOptionsArg: [],
			handlers: {},
			pipeStream: null,
			pipeOpts: null,
		});
	});

	it("passes the input stream as ffmpeg's input", () => {
		const input = makeInputStream();
		transcodeFlacSegment(
			input,
			makeOutputStream(),
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);
		expect(state.inputArg).toBe(input);
	});

	it("transcodes to flac, mono, at the probed sample rate", () => {
		transcodeFlacSegment(
			makeInputStream(),
			makeOutputStream(),
			{ start: 0, end: 60 },
			{ sampleRate: 16000 },
		);
		expect(state.audioCodecArg).toBe("flac");
		expect(state.audioChannelsArg).toBe(1);
		expect(state.audioFrequencyArg).toBe(16000);
		expect(state.formatArg).toBe("flac");
	});

	it("sets compression level 8 in outputOptions", () => {
		transcodeFlacSegment(
			makeInputStream(),
			makeOutputStream(),
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);
		expect(state.outputOptionsArg).toContain("-compression_level 8");
	});

	it("calls seekInput when start > 0", () => {
		transcodeFlacSegment(
			makeInputStream(),
			makeOutputStream(),
			{ start: 120, end: 180 },
			AUDIO_PROPS,
		);
		expect(state.seekInputArg).toBe(120);
	});

	it("does not call seekInput when start === 0", () => {
		transcodeFlacSegment(
			makeInputStream(),
			makeOutputStream(),
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);
		expect(state.seekInputArg).toBeNull();
	});

	it("includes -t <duration> in outputOptions when end is finite", () => {
		transcodeFlacSegment(
			makeInputStream(),
			makeOutputStream(),
			{ start: 60, end: 150 },
			AUDIO_PROPS,
		);
		expect(state.outputOptionsArg).toEqual(
			expect.arrayContaining(["-t", "90"]),
		);
	});

	it("omits -t entirely when end is null (open-ended final segment)", () => {
		transcodeFlacSegment(
			makeInputStream(),
			makeOutputStream(),
			{ start: 120, end: null },
			AUDIO_PROPS,
		);
		expect(state.outputOptionsArg).not.toContain("-t");
	});

	it("pipes to the output stream with { end: true }", () => {
		const out = makeOutputStream();
		transcodeFlacSegment(
			makeInputStream(),
			out,
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);
		expect(state.pipeStream).toBe(out);
		expect(state.pipeOpts).toEqual({ end: true });
	});

	it("resolves when the output stream emits finish", async () => {
		const out = makeOutputStream();
		const promise = transcodeFlacSegment(
			makeInputStream(),
			out,
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);

		out.emit("finish");

		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects, wrapping the stderr tail, when the command emits an error", async () => {
		const out = makeOutputStream();
		const promise = transcodeFlacSegment(
			makeInputStream(),
			out,
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);

		state.handlers.error(new Error("seek failed"), "", "stderr detail");

		await expect(promise).rejects.toThrow("split ffmpeg error: seek failed");
		await expect(promise).rejects.toThrow("stderr detail");
	});

	it("rejects when the output stream emits an error", async () => {
		const out = makeOutputStream();
		const promise = transcodeFlacSegment(
			makeInputStream(),
			out,
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);

		out.emit("error", new Error("upload aborted"));

		await expect(promise).rejects.toThrow(
			"GCS write stream error: upload aborted",
		);
	});

	it("settles only once when both a command error and a stream error fire", async () => {
		const out = makeOutputStream();
		const promise = transcodeFlacSegment(
			makeInputStream(),
			out,
			{ start: 0, end: 60 },
			AUDIO_PROPS,
		);

		state.handlers.error(new Error("ffmpeg died"), "", "");
		out.emit("error", new Error("stream also died"));

		await expect(promise).rejects.toThrow("ffmpeg died");
	});
});
