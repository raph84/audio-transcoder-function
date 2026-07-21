import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// State shared between the vi.mock factory (hoisted) and each test.
const state = vi.hoisted(() => ({
	handlers: {},
	audioFiltersArg: null,
	outputOptionsArg: null,
	pipeStream: null,
	pipeOpts: null,
}));

vi.mock("fluent-ffmpeg", () => {
	function buildCmd() {
		const cmd = {};
		cmd.noVideo = () => cmd;
		cmd.audioFilters = (v) => {
			state.audioFiltersArg = v;
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

import { Readable } from "node:stream";
import {
	computeSplitPoints,
	detectSilence,
	parseSilenceLines,
	selectCutPoint,
} from "./silence.js";

function makeInputStream() {
	return new Readable({ read() {} });
}

describe("parseSilenceLines", () => {
	it("parses a single well-formed silence_start/silence_end pair", () => {
		const { intervals, danglingStart } = parseSilenceLines([
			"[silencedetect @ 0x1] silence_start: 12.345",
			"[silencedetect @ 0x1] silence_end: 15.678 | silence_duration: 3.333",
		]);
		expect(intervals).toEqual([{ start: 12.345, end: 15.678 }]);
		expect(danglingStart).toBeNull();
	});

	it("parses multiple pairs in encounter order", () => {
		const { intervals } = parseSilenceLines([
			"silence_start: 1",
			"silence_end: 2 | silence_duration: 1",
			"silence_start: 10",
			"silence_end: 12.5 | silence_duration: 2.5",
		]);
		expect(intervals).toEqual([
			{ start: 1, end: 2 },
			{ start: 10, end: 12.5 },
		]);
	});

	it("returns a trailing unmatched silence_start as danglingStart, not in intervals", () => {
		const { intervals, danglingStart } = parseSilenceLines([
			"silence_start: 1",
			"silence_end: 2 | silence_duration: 1",
			"silence_start: 50",
		]);
		expect(intervals).toEqual([{ start: 1, end: 2 }]);
		expect(danglingStart).toBe(50);
	});

	it("ignores unrelated ffmpeg progress/banner lines", () => {
		const { intervals, danglingStart } = parseSilenceLines([
			"ffmpeg version 7.0.2-static",
			"frame=  100 fps=25 q=-1.0 size=N/A time=00:00:04.00",
			"silence_start: 1",
			"silence_end: 2 | silence_duration: 1",
		]);
		expect(intervals).toEqual([{ start: 1, end: 2 }]);
		expect(danglingStart).toBeNull();
	});

	it("ignores an unmatched silence_end and logs a warning", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { intervals } = parseSilenceLines([
			"silence_end: 2 | silence_duration: 1",
		]);

		expect(intervals).toEqual([]);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("silence_end without matching silence_start"),
		);

		errorSpy.mockRestore();
	});

	it("parses varying whitespace and decimal precision", () => {
		const { intervals } = parseSilenceLines([
			"silence_start:   7",
			"silence_end:12.5|silence_duration:5.5",
		]);
		expect(intervals).toEqual([{ start: 7, end: 12.5 }]);
	});
});

describe("detectSilence", () => {
	beforeEach(() => {
		Object.assign(state, {
			handlers: {},
			audioFiltersArg: null,
			outputOptionsArg: null,
			pipeStream: null,
			pipeOpts: null,
		});
	});

	it("invokes ffmpeg with the expected silencedetect filter and null muxer", () => {
		detectSilence(makeInputStream(), {
			noiseDb: -30,
			minDurationSeconds: 0.5,
		});

		expect(state.audioFiltersArg).toBe("silencedetect=noise=-30dB:d=0.5");
		expect(state.outputOptionsArg).toEqual(["-f", "null"]);
	});

	it("resolves with parsed, sorted silence intervals", async () => {
		const promise = detectSilence(makeInputStream(), {
			noiseDb: -30,
			minDurationSeconds: 0.5,
		});

		state.handlers.stderr("silence_start: 10");
		state.handlers.stderr("silence_end: 12 | silence_duration: 2");
		state.handlers.stderr("silence_start: 1");
		state.handlers.stderr("silence_end: 2 | silence_duration: 1");

		state.pipeStream.end();

		await expect(promise).resolves.toEqual([
			{ start: 1, end: 2 },
			{ start: 10, end: 12 },
		]);
	});

	it("closes a dangling trailing silence_start to the given durationSeconds", async () => {
		const promise = detectSilence(makeInputStream(), {
			noiseDb: -30,
			minDurationSeconds: 0.5,
			durationSeconds: 100,
		});

		state.handlers.stderr("silence_start: 90");
		state.pipeStream.end();

		await expect(promise).resolves.toEqual([{ start: 90, end: 100 }]);
	});

	it("drops a dangling trailing silence_start with a warning when durationSeconds isn't provided", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const promise = detectSilence(makeInputStream(), {
			noiseDb: -30,
			minDurationSeconds: 0.5,
		});

		state.handlers.stderr("silence_start: 90");
		state.pipeStream.end();

		await expect(promise).resolves.toEqual([]);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("dangling silence_start at EOF"),
		);

		errorSpy.mockRestore();
	});

	it("rejects, wrapping the stderr tail, when the command emits error", async () => {
		const promise = detectSilence(makeInputStream(), {
			noiseDb: -30,
			minDurationSeconds: 0.5,
		});

		state.handlers.error(new Error("decode failed"), "", "stderr detail");

		await expect(promise).rejects.toThrow(
			"silencedetect ffmpeg error: decode failed",
		);
		await expect(promise).rejects.toThrow("stderr detail");
	});

	it("rejects when the discard stream emits an error", async () => {
		const promise = detectSilence(makeInputStream(), {
			noiseDb: -30,
			minDurationSeconds: 0.5,
		});

		state.pipeStream.emit("error", new Error("discard broke"));

		await expect(promise).rejects.toThrow(
			"silencedetect discard stream error: discard broke",
		);
	});
});

describe("computeSplitPoints", () => {
	let errorSpy;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("returns [] when durationSeconds is strictly below the split interval", () => {
		expect(
			computeSplitPoints({
				durationSeconds: 100,
				splitAfterSeconds: 3600,
				silenceIntervals: [],
				lookbackMaxSeconds: 60,
			}),
		).toEqual([]);
	});

	it("returns [] when durationSeconds exactly equals the split interval", () => {
		expect(
			computeSplitPoints({
				durationSeconds: 3600,
				splitAfterSeconds: 3600,
				silenceIntervals: [],
				lookbackMaxSeconds: 60,
			}),
		).toEqual([]);
	});

	it("hard-cuts every boundary when there is no silence at all", () => {
		const segments = computeSplitPoints({
			durationSeconds: 250,
			splitAfterSeconds: 100,
			silenceIntervals: [],
			lookbackMaxSeconds: 30,
		});
		// boundaries at 100, 200 -> 3 segments
		expect(segments).toEqual([
			{ start: 0, end: 100 },
			{ start: 100, end: 200 },
			{ start: 200, end: null },
		]);
	});

	it("cuts at the midpoint of a silence interval containing the boundary", () => {
		const segments = computeSplitPoints({
			durationSeconds: 250,
			splitAfterSeconds: 100,
			silenceIntervals: [{ start: 98, end: 104 }],
			lookbackMaxSeconds: 30,
		});
		expect(segments[0]).toEqual({ start: 0, end: 101 });
	});

	it("treats boundary-inclusive edges as containing", () => {
		expect(selectCutPoint(100, [{ start: 100, end: 106 }], 30)).toBe(103);
		expect(selectCutPoint(100, [{ start: 94, end: 100 }], 30)).toBe(97);
	});

	it("falls back to the nearest preceding silence interval within the lookback window", () => {
		const cut = selectCutPoint(
			100,
			[{ start: 80, end: 85 }],
			30, // lookback covers [70, 100]
		);
		expect(cut).toBe(82.5);
	});

	it("picks the candidate closest to the boundary when multiple precede it", () => {
		const cut = selectCutPoint(
			100,
			[
				{ start: 60, end: 65 },
				{ start: 85, end: 90 },
			],
			30,
		);
		expect(cut).toBe(87.5);
	});

	it("hard-cuts at the boundary and warns when the nearest silence is outside the lookback window", () => {
		const cut = selectCutPoint(100, [{ start: 10, end: 15 }], 30);

		expect(cut).toBe(100);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("no silence found near split boundary"),
		);
	});

	it("resolves multiple boundaries independently with different strategies", () => {
		const segments = computeSplitPoints({
			durationSeconds: 350,
			splitAfterSeconds: 100,
			silenceIntervals: [
				{ start: 99, end: 101 }, // contains boundary at 100 -> cut 100
				{ start: 170, end: 175 }, // precedes boundary at 200, within lookback -> cut 172.5
				// no silence near boundary at 300 -> hard cut at 300
			],
			lookbackMaxSeconds: 30,
		});

		expect(segments).toEqual([
			{ start: 0, end: 100 },
			{ start: 100, end: 172.5 },
			{ start: 172.5, end: 300 },
			{ start: 300, end: null },
		]);
	});

	it("drops a collapsed cut so the segment list stays strictly increasing", () => {
		// Two boundaries (100, 200) both resolve near the same silence interval,
		// which would otherwise produce a non-increasing cut sequence.
		const segments = computeSplitPoints({
			durationSeconds: 250,
			splitAfterSeconds: 100,
			silenceIntervals: [{ start: 95, end: 96 }],
			lookbackMaxSeconds: 150,
		});

		// boundary 100 -> cut 95.5 (lookback); boundary 200 -> also resolves to
		// the same interval (still within a 150s lookback of 200) -> 95.5 again,
		// which collapses and is dropped, leaving one fewer segment.
		expect(segments).toEqual([
			{ start: 0, end: 95.5 },
			{ start: 95.5, end: null },
		]);
	});

	it("produces contiguous segments starting at 0", () => {
		const segments = computeSplitPoints({
			durationSeconds: 300,
			splitAfterSeconds: 100,
			silenceIntervals: [],
			lookbackMaxSeconds: 10,
		});

		expect(segments[0].start).toBe(0);
		for (let i = 1; i < segments.length; i++) {
			expect(segments[i].start).toBe(segments[i - 1].end);
		}
	});
});
