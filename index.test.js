import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientError } from "./src/errors.js";

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

	it("does not attempt splitting when PART_LENGTH_SECONDS is unset (default test env)", async () => {
		mockProbeAudio.mockResolvedValue({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
		mockTranscodeToFlac.mockResolvedValue({ duration: 999999 });

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockTranscodeToFlac).toHaveBeenCalledTimes(1);
		expect(mockCreateWriteStream).toHaveBeenCalledTimes(1);
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

	it("passes the probed sampleRate to transcodeToFlac for the full transcode", async () => {
		const audioProps = { codec: "aac", sampleRate: 16000, channels: 1 };
		mockProbeAudio.mockResolvedValue(audioProps);
		mockTranscodeToFlac.mockResolvedValue();

		await reg.handler({ data: { bucket: "b", name: "source/file.m4a" } });

		expect(mockTranscodeToFlac).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{ sampleRate: 16000 },
		);
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
