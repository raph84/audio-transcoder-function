import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All state that is referenced inside vi.mock() factories must be created with
// vi.hoisted() so it is initialized before the factories run.
const {
	reg,
	mockCreateWriteStream,
	mockFile,
	mockBucket,
	mockProbeAudio,
	mockTranscodeToFlac,
	mockPrepareInputSource,
} = vi.hoisted(() => {
	const mockCreateWriteStream = vi.fn();
	const mockFile = vi.fn(() => ({
		createWriteStream: mockCreateWriteStream,
	}));
	const mockBucket = vi.fn(() => ({ file: mockFile }));

	return {
		reg: { handler: null },
		mockCreateWriteStream,
		mockFile,
		mockBucket,
		mockProbeAudio: vi.fn(),
		mockTranscodeToFlac: vi.fn(),
		mockPrepareInputSource: vi.fn(),
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

// Import index.js — triggers the cloudEvent() registration.
import "./index.js";

function makeInputStream() {
	const stream = new EventEmitter();
	stream.destroy = vi.fn();
	return stream;
}

describe("transcodeAudio handler", () => {
	let mockOpenProbeInput;
	let mockOpenTranscodeInput;
	let mockCleanup;

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreateWriteStream.mockReturnValue(new EventEmitter());
		mockFile.mockReturnValue({ createWriteStream: mockCreateWriteStream });
		mockBucket.mockReturnValue({ file: mockFile });

		mockOpenProbeInput = vi.fn(makeInputStream);
		mockOpenTranscodeInput = vi.fn(makeInputStream);
		mockCleanup = vi.fn().mockResolvedValue(undefined);
		mockPrepareInputSource.mockResolvedValue({
			fastStart: true,
			openProbeInput: mockOpenProbeInput,
			openTranscodeInput: mockOpenTranscodeInput,
			cleanup: mockCleanup,
		});
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

	// --- input source ---

	it("opens the input source separately for probe and transcode", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockOpenProbeInput).toHaveBeenCalledOnce();
		expect(mockOpenTranscodeInput).toHaveBeenCalledOnce();
	});

	it("logs when the faststart check is not confirmed true (non-faststart or inconclusive)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		mockPrepareInputSource.mockResolvedValue({
			fastStart: false,
			openProbeInput: mockOpenProbeInput,
			openTranscodeInput: mockOpenTranscodeInput,
			cleanup: mockCleanup,
		});
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		const logged = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
		expect(
			logged.some((entry) => entry.msg?.includes("using local temp file")),
		).toBe(true);
	});

	it("does not log the temp-file message when the file is faststart", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		const logged = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
		expect(
			logged.some((entry) => entry.msg?.includes("using local temp file")),
		).toBe(false);
	});

	// --- cleanup ---

	it("calls cleanup after a successful run", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockCleanup).toHaveBeenCalledOnce();
	});

	it("calls cleanup even when probe fails", async () => {
		mockProbeAudio.mockRejectedValue(new Error("ffprobe failed"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("ffprobe failed");

		expect(mockCleanup).toHaveBeenCalledOnce();
	});

	it("calls cleanup even when transcode fails", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockRejectedValue(new Error("encoding failed"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("encoding failed");

		expect(mockCleanup).toHaveBeenCalledOnce();
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

	// --- error propagation ---

	it("rethrows probe errors so Eventarc can retry", async () => {
		mockProbeAudio.mockRejectedValue(new Error("ffprobe failed"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("ffprobe failed");

		expect(mockTranscodeToFlac).not.toHaveBeenCalled();
	});

	it("rethrows transcode errors so Eventarc can retry", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockRejectedValue(new Error("encoding failed"));

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("encoding failed");
	});

	it("does not rethrow moov-atom errors to prevent Eventarc retry loops", async () => {
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

	it("throws when probe returns an invalid sampleRate", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: Number.NaN,
			channels: 2,
		});

		await expect(
			reg.handler({ data: { bucket: "b", name: "source/file.m4a" } }),
		).rejects.toThrow("invalid sampleRate");
	});
});
