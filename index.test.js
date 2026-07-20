import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientError } from "./src/errors.js";

// All state that is referenced inside vi.mock() factories must be created with
// vi.hoisted() so it is initialized before the factories run.
const {
	reg,
	mockCreateReadStream,
	mockCreateWriteStream,
	mockGetSignedUrl,
	mockFile,
	mockBucket,
	mockProbeAudio,
	mockTranscodeToFlac,
	mockDetectSilence,
	mockComputeSplitPoints,
	mockCutFlacSegment,
} = vi.hoisted(() => {
	const mockCreateReadStream = vi.fn();
	const mockCreateWriteStream = vi.fn();
	const mockGetSignedUrl = vi.fn();
	const mockFile = vi.fn(() => ({
		createReadStream: mockCreateReadStream,
		createWriteStream: mockCreateWriteStream,
		getSignedUrl: mockGetSignedUrl,
	}));
	const mockBucket = vi.fn(() => ({ file: mockFile }));

	return {
		reg: { handler: null },
		mockCreateReadStream,
		mockCreateWriteStream,
		mockGetSignedUrl,
		mockFile,
		mockBucket,
		mockProbeAudio: vi.fn(),
		mockTranscodeToFlac: vi.fn(),
		mockDetectSilence: vi.fn(),
		mockComputeSplitPoints: vi.fn(),
		mockCutFlacSegment: vi.fn(),
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
vi.mock("./src/silence.js", () => ({
	detectSilence: mockDetectSilence,
	computeSplitPoints: mockComputeSplitPoints,
}));
vi.mock("./src/split.js", () => ({ cutFlacSegment: mockCutFlacSegment }));

// Import index.js — triggers the cloudEvent() registration.
import "./index.js";

describe("transcodeAudio handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateReadStream.mockReturnValue(new EventEmitter());
		mockCreateWriteStream.mockReturnValue(new EventEmitter());
		mockFile.mockReturnValue({
			createReadStream: mockCreateReadStream,
			createWriteStream: mockCreateWriteStream,
			getSignedUrl: mockGetSignedUrl,
		});
		mockBucket.mockReturnValue({ file: mockFile });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// --- prefix filtering ---

	it("skips files outside SOURCE_PREFIX without calling probe", async () => {
		await reg.handler({ data: { bucket: "b", name: "other/file.m4a" } });
		expect(mockProbeAudio).not.toHaveBeenCalled();
	});

	it("skips files at the bucket root without calling probe", async () => {
		await reg.handler({ data: { bucket: "b", name: "file.m4a" } });
		expect(mockProbeAudio).not.toHaveBeenCalled();
	});

	// --- extension filtering ---

	it("skips non-M4A files under the source prefix without calling probe", async () => {
		await reg.handler({ data: { bucket: "b", name: "source/file.txt" } });
		expect(mockProbeAudio).not.toHaveBeenCalled();
	});

	it("skips .flac files under the source prefix (infinite-loop guard)", async () => {
		await reg.handler({ data: { bucket: "b", name: "source/file.flac" } });
		expect(mockProbeAudio).not.toHaveBeenCalled();
	});

	it("processes .M4A files regardless of extension case", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/FILE.M4A" } });

		expect(mockProbeAudio).toHaveBeenCalledOnce();
	});

	// --- output path computation ---

	it("creates the write stream with correct output path and contentType", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({
			data: { bucket: "my-bucket", name: "source/recordings/session.m4a" },
		});

		expect(mockCreateWriteStream).toHaveBeenCalledWith({
			resumable: false,
			metadata: { contentType: "audio/flac" },
		});
		const writtenPaths = mockFile.mock.calls.map((c) => c[0]);
		expect(writtenPaths).toContain("transcoded/recordings/session.flac");
	});

	it("handles a flat source path (no subdirectory)", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/session.m4a" } });

		const writtenPaths = mockFile.mock.calls.map((c) => c[0]);
		expect(writtenPaths).toContain("transcoded/session.flac");
	});

	// --- two read streams ---

	it("opens two separate read streams: one for probe, one for transcode", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockCreateReadStream).toHaveBeenCalledTimes(2);
	});

	// --- probed audio properties forwarded ---

	it("passes probed audio properties to transcodeToFlac", async () => {
		const audioProps = { codec: "aac", sampleRate: 16000, channels: 1 };
		mockProbeAudio.mockResolvedValue(audioProps);
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockTranscodeToFlac).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			audioProps,
		);
	});

	// --- split feature no-op when SPLIT_AFTER_MINUTES is unset ---

	it("never calls the split pipeline when SPLIT_AFTER_MINUTES is unset (default test env)", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
			durationSeconds: 999999,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockDetectSilence).not.toHaveBeenCalled();
		expect(mockComputeSplitPoints).not.toHaveBeenCalled();
		expect(mockCutFlacSegment).not.toHaveBeenCalled();
		expect(mockGetSignedUrl).not.toHaveBeenCalled();
		expect(mockCreateReadStream).toHaveBeenCalledTimes(2);
	});

	// --- error propagation ---

	it("rethrows transient probe errors so Eventarc can retry", async () => {
		mockProbeAudio.mockRejectedValue(
			new TransientError("source read stream error: ECONNRESET"),
		);

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("ECONNRESET");

		expect(mockTranscodeToFlac).not.toHaveBeenCalled();
	});

	it("does not rethrow permanent probe errors, to avoid retrying forever", async () => {
		mockProbeAudio.mockRejectedValue(new Error("No audio stream found"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).resolves.toBeUndefined();

		expect(mockTranscodeToFlac).not.toHaveBeenCalled();
	});

	it("rethrows transient transcode errors so Eventarc can retry", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockRejectedValue(
			new TransientError("GCS write stream error: upload aborted"),
		);

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("upload aborted");
	});

	it("does not rethrow permanent transcode errors (e.g. moov atom, codec failures), to avoid retrying forever", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockRejectedValue(new Error("moov atom not found"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).resolves.toBeUndefined();
	});

	it("does not rethrow when probe returns an invalid sampleRate", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: Number.NaN,
			channels: 2,
		});

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).resolves.toBeUndefined();

		expect(mockTranscodeToFlac).not.toHaveBeenCalled();
	});
});

describe("transcodeAudio handler — splitting (SPLIT_AFTER_MINUTES=60)", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.stubEnv("SPLIT_AFTER_MINUTES", "60");

		vi.clearAllMocks();
		mockCreateReadStream.mockReturnValue(new EventEmitter());
		mockCreateWriteStream.mockReturnValue(new EventEmitter());
		mockGetSignedUrl.mockResolvedValue(["https://signed.example/fake-url"]);
		mockFile.mockReturnValue({
			createReadStream: mockCreateReadStream,
			createWriteStream: mockCreateWriteStream,
			getSignedUrl: mockGetSignedUrl,
		});
		mockBucket.mockReturnValue({ file: mockFile });
		mockTranscodeToFlac.mockResolvedValue();
		mockCutFlacSegment.mockResolvedValue();

		// Re-importing index.js re-runs the cloudEvent(...) registration
		// (via the mocked functions-framework), overwriting reg.handler with
		// a handler built against the freshly-stubbed SPLIT_AFTER_MINUTES.
		await import("./index.js");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("skips the split pipeline when durationSeconds is at or below the threshold", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
			durationSeconds: 3600, // exactly the 60-minute threshold
		});

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockDetectSilence).not.toHaveBeenCalled();
		expect(mockComputeSplitPoints).not.toHaveBeenCalled();
		expect(mockCutFlacSegment).not.toHaveBeenCalled();
	});

	it("skips the split pipeline when durationSeconds is unknown (null)", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
			durationSeconds: null,
		});

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).resolves.toBeUndefined();

		expect(mockDetectSilence).not.toHaveBeenCalled();
	});

	it("runs the full split pipeline when duration exceeds the threshold", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
			durationSeconds: 7200, // 2 hours, above the 60-minute threshold
		});

		const silenceIntervals = [{ start: 3590, end: 3595 }];

		const segments = [
			{ start: 0, end: 3592.5 },
			{ start: 3592.5, end: 7000 },
			{ start: 7000, end: null },
		];
		mockComputeSplitPoints.mockReturnValue(segments);

		const callOrder = [];
		mockTranscodeToFlac.mockImplementation(async () => {
			callOrder.push("transcode");
		});
		mockDetectSilence.mockImplementation(async () => {
			callOrder.push("detectSilence");
			return silenceIntervals;
		});
		mockCutFlacSegment.mockImplementation(async (_url, _stream, segment) => {
			callOrder.push(`cut-start-${segment.start}`);
			await Promise.resolve();
			callOrder.push(`cut-end-${segment.start}`);
		});

		await reg.handler({
			data: { bucket: "my-bucket", name: "source/recordings/session.m4a" },
		});

		// transcode resolves before detectSilence is ever invoked.
		expect(callOrder[0]).toBe("transcode");
		expect(callOrder[1]).toBe("detectSilence");

		// A third, fresh read stream is opened for the silencedetect pass
		// (probe + main transcode + silencedetect).
		expect(mockCreateReadStream).toHaveBeenCalledTimes(3);

		expect(mockComputeSplitPoints).toHaveBeenCalledWith({
			durationSeconds: 7200,
			splitAfterSeconds: 3600,
			silenceIntervals,
			lookbackMaxSeconds: 120,
		});

		expect(mockGetSignedUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				version: "v4",
				action: "read",
				expires: expect.any(Number),
			}),
		);
		expect(mockGetSignedUrl.mock.calls[0][0].expires).toBeGreaterThan(
			Date.now(),
		);

		// getSignedUrl was requested on the full output file.
		const filePaths = mockFile.mock.calls.map((c) => c[0]);
		expect(filePaths).toContain("transcoded/recordings/session.flac");

		// cutFlacSegment called once per segment, all started concurrently
		// (each part is an independent read + write, so all three "start"
		// before any of them "end").
		expect(mockCutFlacSegment).toHaveBeenCalledTimes(3);
		expect(callOrder.slice(2)).toEqual([
			"cut-start-0",
			"cut-start-3592.5",
			"cut-start-7000",
			"cut-end-0",
			"cut-end-3592.5",
			"cut-end-7000",
		]);

		expect(filePaths).toContain("transcoded/recordings/session.part001.flac");
		expect(filePaths).toContain("transcoded/recordings/session.part002.flac");
		expect(filePaths).toContain("transcoded/recordings/session.part003.flac");

		for (const call of mockCutFlacSegment.mock.calls) {
			expect(call[0]).toBe("https://signed.example/fake-url");
		}
	});

	it("logs and swallows a detectSilence failure without failing the invocation", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
			durationSeconds: 7200,
		});
		mockDetectSilence.mockRejectedValue(new Error("silencedetect crashed"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).resolves.toBeUndefined();

		expect(mockTranscodeToFlac).toHaveBeenCalledOnce();
		expect(mockCutFlacSegment).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("split failed"),
		);

		errorSpy.mockRestore();
	});

	it("logs and swallows a cutFlacSegment failure without failing the invocation, even when other parts succeed", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
			durationSeconds: 7200,
		});
		mockDetectSilence.mockResolvedValue([]);
		mockComputeSplitPoints.mockReturnValue([
			{ start: 0, end: 3600 },
			{ start: 3600, end: 7000 },
			{ start: 7000, end: null },
		]);
		mockCutFlacSegment
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("upload aborted"))
			.mockResolvedValueOnce(undefined);

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).resolves.toBeUndefined();

		// All parts are cut concurrently, so a failure in one doesn't stop the
		// others from being attempted.
		expect(mockCutFlacSegment).toHaveBeenCalledTimes(3);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("split failed"),
		);

		errorSpy.mockRestore();
	});
});
