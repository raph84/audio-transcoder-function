import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// State shared between the vi.mock factory (hoisted) and each test.
const state = vi.hoisted(() => ({
	inputArg: null,
	seekInputArg: null,
	outputOptionsArg: null,
	formatArg: null,
	handlers: {},
	pipeStream: null,
	pipeOpts: null,
}));

vi.mock("fluent-ffmpeg", () => {
	function buildCmd(input) {
		state.inputArg = input;
		const cmd = {};
		cmd.seekInput = (v) => {
			state.seekInputArg = v;
			return cmd;
		};
		cmd.outputOptions = (v) => {
			state.outputOptionsArg = v;
			return cmd;
		};
		cmd.format = (v) => {
			state.formatArg = v;
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

import { cutFlacSegment } from "./split.js";

function makeOutputStream() {
	return new EventEmitter();
}

const SIGNED_URL = "https://storage.googleapis.com/bucket/obj?sig=abc";

describe("cutFlacSegment", () => {
	beforeEach(() => {
		Object.assign(state, {
			inputArg: null,
			seekInputArg: null,
			outputOptionsArg: null,
			formatArg: null,
			handlers: {},
			pipeStream: null,
			pipeOpts: null,
		});
	});

	it("passes the signed URL as ffmpeg's input", () => {
		cutFlacSegment(SIGNED_URL, makeOutputStream(), { start: 0, end: 60 });
		expect(state.inputArg).toBe(SIGNED_URL);
	});

	it("calls seekInput when start > 0", () => {
		cutFlacSegment(SIGNED_URL, makeOutputStream(), { start: 120, end: 180 });
		expect(state.seekInputArg).toBe(120);
	});

	it("does not call seekInput when start === 0", () => {
		cutFlacSegment(SIGNED_URL, makeOutputStream(), { start: 0, end: 60 });
		expect(state.seekInputArg).toBeNull();
	});

	it("includes -t <duration> in outputOptions when end is finite", () => {
		cutFlacSegment(SIGNED_URL, makeOutputStream(), { start: 60, end: 150 });
		expect(state.outputOptionsArg).toEqual(["-c", "copy", "-t", "90"]);
	});

	it("omits -t/-to entirely when end is null (open-ended final segment)", () => {
		cutFlacSegment(SIGNED_URL, makeOutputStream(), { start: 120, end: null });
		expect(state.outputOptionsArg).toEqual(["-c", "copy"]);
	});

	it("always includes -c copy and sets format to flac", () => {
		cutFlacSegment(SIGNED_URL, makeOutputStream(), { start: 0, end: 60 });
		expect(state.outputOptionsArg).toContain("-c");
		expect(state.outputOptionsArg).toContain("copy");
		expect(state.formatArg).toBe("flac");
	});

	it("pipes to the output stream with { end: true }", () => {
		const out = makeOutputStream();
		cutFlacSegment(SIGNED_URL, out, { start: 0, end: 60 });
		expect(state.pipeStream).toBe(out);
		expect(state.pipeOpts).toEqual({ end: true });
	});

	it("resolves when the output stream emits finish", async () => {
		const out = makeOutputStream();
		const promise = cutFlacSegment(SIGNED_URL, out, { start: 0, end: 60 });

		out.emit("finish");

		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects, wrapping the stderr tail, when the command emits an error", async () => {
		const out = makeOutputStream();
		const promise = cutFlacSegment(SIGNED_URL, out, { start: 0, end: 60 });

		state.handlers.error(new Error("seek failed"), "", "stderr detail");

		await expect(promise).rejects.toThrow("split ffmpeg error: seek failed");
		await expect(promise).rejects.toThrow("stderr detail");
	});

	it("rejects when the output stream emits an error", async () => {
		const out = makeOutputStream();
		const promise = cutFlacSegment(SIGNED_URL, out, { start: 0, end: 60 });

		out.emit("error", new Error("upload aborted"));

		await expect(promise).rejects.toThrow(
			"GCS write stream error: upload aborted",
		);
	});

	it("settles only once when both a command error and a stream error fire", async () => {
		const out = makeOutputStream();
		const promise = cutFlacSegment(SIGNED_URL, out, { start: 0, end: 60 });

		state.handlers.error(new Error("ffmpeg died"), "", "");
		out.emit("error", new Error("stream also died"));

		await expect(promise).rejects.toThrow("ffmpeg died");
	});
});
