import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientError } from "./src/errors.js";

// PART_LENGTH_SECONDS/PART_OVERLAP_SECONDS are read once at src/config.js
// import time, so they must be set before index.js (which imports config.js)
// is ever imported in this module graph — hence a separate test file from
// index.test.js, which relies on these vars being unset. Plain top-level
// statements run in source order, but `import` declarations (including the
// side-effect-only `import "./index.js"` below) are hoisted above them per
// the ES module spec — so this must go inside vi.hoisted() to actually run
// before that import is evaluated.
vi.hoisted(() => {
	process.env.PART_LENGTH_SECONDS = "120";
	process.env.PART_OVERLAP_SECONDS = "15";
});

// All state that is referenced inside vi.mock() factories must be created with
// vi.hoisted() so it is initialized before the factories run.
const {
	reg,
	mockCreateReadStream,
	mockCreateWriteStream,
	mockFile,
	mockBucket,
	mockProbeAudio,
	mockTranscodeToFlac,
	mockPrepareInputSource,
	mockCleanup,
} = vi.hoisted(() => {
	const mockCreateReadStream = vi.fn();
	const mockCreateWriteStream = vi.fn();
	const mockFile = vi.fn(() => ({
		createReadStream: mockCreateReadStream,
		createWriteStream: mockCreateWriteStream,
	}));
	const mockBucket = vi.fn(() => ({ file: mockFile }));

	return {
		reg: { handler: null },
		mockCreateReadStream,
		mockCreateWriteStream,
		mockFile,
		mockBucket,
		mockProbeAudio: vi.fn(),
		mockTranscodeToFlac: vi.fn(),
		mockPrepareInputSource: vi.fn(),
		mockCleanup: vi.fn(),
	};
});

vi.mock("@google-cloud/functions-framework", () => ({
	cloudEvent: vi.fn((_name, fn) => {
		reg.handler = fn;
	}),
}));

vi.mock("@google-cloud/storage", () => ({
	Storage: vi.fn(function () {
		this.bucket = mockBucket;
	}),
}));

vi.mock("./src/probe.js", () => ({ probeAudio: mockProbeAudio }));
vi.mock("./src/transcode.js", () => ({ transcodeToFlac: mockTranscodeToFlac }));
vi.mock("./src/inputSource.js", () => ({
	prepareInputSource: mockPrepareInputSource,
}));

// src/parts.js is intentionally left unmocked: computeParts is pure logic,
// and exercising it for real gives higher-confidence coverage of the exact
// segment math end-to-end.

// Import index.js — triggers the cloudEvent() registration.
import "./index.js";

const defaultAudioProps = { codec: "aac", sampleRate: 44100, channels: 2 };

describe("transcodeAudio handler — splitting into parts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateReadStream.mockReturnValue(new EventEmitter());
		mockCreateWriteStream.mockReturnValue(new EventEmitter());
		mockFile.mockReturnValue({
			createReadStream: mockCreateReadStream,
			createWriteStream: mockCreateWriteStream,
		});
		mockBucket.mockReturnValue({ file: mockFile });
		mockProbeAudio.mockResolvedValue(defaultAudioProps);
		mockCleanup.mockResolvedValue(undefined);
		mockPrepareInputSource.mockResolvedValue({
			fastStart: true,
			openProbeInput: () => mockCreateReadStream(),
			openTranscodeInput: () => mockCreateReadStream(),
			cleanup: mockCleanup,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("only runs the full transcode when the measured duration does not exceed PART_LENGTH_SECONDS", async () => {
		mockTranscodeToFlac.mockResolvedValue({ duration: 100 });

		await reg.handler({
			data: { bucket: "b", name: "source/session.m4a" },
		});

		expect(mockTranscodeToFlac).toHaveBeenCalledTimes(1);
		expect(mockCreateWriteStream).toHaveBeenCalledTimes(1);
	});

	it("splits into the correct number of parts with correct startTime/duration", async () => {
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 }) // full transcode
			.mockResolvedValue({ duration: undefined }); // parts

		await reg.handler({
			data: { bucket: "b", name: "source/session.m4a" },
		});

		// 1 full transcode + 3 parts for duration=300, length=120, overlap=15
		expect(mockTranscodeToFlac).toHaveBeenCalledTimes(4);

		const partCalls = mockTranscodeToFlac.mock.calls.slice(1);
		expect(partCalls.map((c) => c[2])).toEqual([
			{ sampleRate: 44100, startTime: 0, duration: 120 },
			{ sampleRate: 44100, startTime: 105, duration: 120 },
			{ sampleRate: 44100, startTime: 210, duration: 90 },
		]);
	});

	it("names part outputs with a zero-padded suffix alongside the full file", async () => {
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 })
			.mockResolvedValue({ duration: undefined });

		await reg.handler({
			data: { bucket: "b", name: "source/session.m4a" },
		});

		const writtenPaths = mockFile.mock.calls.map((c) => c[0]);
		expect(writtenPaths).toContain("transcoded/session.flac");
		expect(writtenPaths).toContain("transcoded/session.part001.flac");
		expect(writtenPaths).toContain("transcoded/session.part002.flac");
		expect(writtenPaths).toContain("transcoded/session.part003.flac");
	});

	it("opens a fresh read stream and write stream per part", async () => {
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 })
			.mockResolvedValue({ duration: undefined });

		await reg.handler({
			data: { bucket: "b", name: "source/session.m4a" },
		});

		// probe + full transcode + 3 parts = 5 read streams
		expect(mockCreateReadStream).toHaveBeenCalledTimes(5);
		// full transcode + 3 parts = 4 write streams
		expect(mockCreateWriteStream).toHaveBeenCalledTimes(4);
		for (const call of mockCreateWriteStream.mock.calls) {
			expect(call[0]).toEqual({
				resumable: false,
				metadata: { contentType: "audio/flac" },
			});
		}
	});

	it("swallows a permanent failure on a part and stops attempting further parts", async () => {
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 }) // full transcode
			.mockResolvedValueOnce({ duration: undefined }) // part 1
			.mockRejectedValueOnce(new Error("codec error")); // part 2

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/session.m4a" } }),
		).resolves.toBeUndefined();

		// full + part1 + part2 attempted, part3 never attempted
		expect(mockTranscodeToFlac).toHaveBeenCalledTimes(3);
	});

	it("swallows a transient failure on a part without rethrowing (no Eventarc retry)", async () => {
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 }) // full transcode
			.mockRejectedValueOnce(new TransientError("ECONNRESET")); // part 1

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/session.m4a" } }),
		).resolves.toBeUndefined();

		expect(mockTranscodeToFlac).toHaveBeenCalledTimes(2);
	});

	it("skips splitting but still completes the full transcode when duration could not be measured", async () => {
		mockTranscodeToFlac.mockResolvedValue({ duration: undefined });

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/session.m4a" } }),
		).resolves.toBeUndefined();

		expect(mockTranscodeToFlac).toHaveBeenCalledTimes(1);
	});

	it("cleans up the input source exactly once, after all parts finish", async () => {
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 })
			.mockResolvedValue({ duration: undefined });

		await reg.handler({ data: { bucket: "b", name: "source/session.m4a" } });

		expect(mockCleanup).toHaveBeenCalledOnce();
	});

	it("reuses the same local temp file path for the full transcode and every part when non-faststart", async () => {
		mockPrepareInputSource.mockResolvedValue({
			fastStart: false,
			openProbeInput: () => "/tmp/fake-path.m4a",
			openTranscodeInput: () => "/tmp/fake-path.m4a",
			cleanup: mockCleanup,
		});
		mockTranscodeToFlac
			.mockResolvedValueOnce({ duration: 300 })
			.mockResolvedValue({ duration: undefined });

		await reg.handler({ data: { bucket: "b", name: "source/session.m4a" } });

		// full transcode + 3 parts, all against the same local path
		expect(mockCreateReadStream).not.toHaveBeenCalled();
		for (const call of mockTranscodeToFlac.mock.calls) {
			expect(call[0]).toBe("/tmp/fake-path.m4a");
		}
	});
});
