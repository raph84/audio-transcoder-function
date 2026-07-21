import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsFastStart, mockUnlink, mockDownload, mockCreateReadStream } =
	vi.hoisted(() => ({
		mockIsFastStart: vi.fn(),
		mockUnlink: vi.fn().mockResolvedValue(undefined),
		mockDownload: vi.fn().mockResolvedValue(undefined),
		mockCreateReadStream: vi.fn(),
	}));

vi.mock("./mp4.js", () => ({
	isFastStart: mockIsFastStart,
	PREFIX_BYTES: 65536,
}));

vi.mock("node:fs/promises", () => ({ unlink: mockUnlink }));

// stream/consumers' buffer() reads a real (async-iterable) stream to
// completion, so hand it a genuine Readable rather than an EventEmitter stub.
function makePrefixStream(chunks = [Buffer.from("prefix")]) {
	return Readable.from(chunks);
}

function makeErrorStream(err) {
	return new Readable({
		read() {
			this.destroy(err);
		},
	});
}

function makeSourceFile() {
	return {
		createReadStream: mockCreateReadStream,
		download: mockDownload,
	};
}

import { TransientError } from "./errors.js";
import { prepareInputSource } from "./inputSource.js";

describe("prepareInputSource", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUnlink.mockResolvedValue(undefined);
		mockDownload.mockResolvedValue(undefined);
	});

	it("reads only the leading PREFIX_BYTES range to make the faststart check", async () => {
		mockCreateReadStream.mockReturnValueOnce(makePrefixStream());
		mockIsFastStart.mockReturnValue(true);

		await prepareInputSource(makeSourceFile());

		expect(mockCreateReadStream).toHaveBeenCalledWith({
			start: 0,
			end: 65535,
		});
	});

	it("rejects with a TransientError when the prefix read stream errors", async () => {
		mockCreateReadStream.mockReturnValueOnce(
			makeErrorStream(new Error("ECONNRESET")),
		);

		await expect(prepareInputSource(makeSourceFile())).rejects.toThrow(
			"source read stream error: ECONNRESET",
		);
		await expect(prepareInputSource(makeSourceFile())).rejects.toBeInstanceOf(
			TransientError,
		);
	});

	describe("when the file is faststart", () => {
		it("streams directly from GCS for both probe and transcode without downloading", async () => {
			mockCreateReadStream.mockReturnValueOnce(makePrefixStream());
			mockIsFastStart.mockReturnValue(true);
			const sourceFile = makeSourceFile();

			const result = await prepareInputSource(sourceFile);

			expect(result.fastStart).toBe(true);
			expect(mockDownload).not.toHaveBeenCalled();

			mockCreateReadStream.mockReturnValueOnce("probe-stream");
			mockCreateReadStream.mockReturnValueOnce("transcode-stream");
			expect(result.openProbeInput()).toBe("probe-stream");
			expect(result.openTranscodeInput()).toBe("transcode-stream");
			expect(mockCreateReadStream).toHaveBeenCalledTimes(3); // prefix + probe + transcode
		});

		it("cleanup is a no-op", async () => {
			mockCreateReadStream.mockReturnValueOnce(makePrefixStream());
			mockIsFastStart.mockReturnValue(true);

			const result = await prepareInputSource(makeSourceFile());
			await result.cleanup();

			expect(mockUnlink).not.toHaveBeenCalled();
		});
	});

	describe.each([
		["non-faststart", false],
		["inconclusive", null],
	])("when the check is %s", (_label, fastStartValue) => {
		it("downloads the object to a local temp path for both probe and transcode", async () => {
			mockCreateReadStream.mockReturnValueOnce(makePrefixStream());
			mockIsFastStart.mockReturnValue(fastStartValue);
			const sourceFile = makeSourceFile();

			const result = await prepareInputSource(sourceFile);

			expect(result.fastStart).toBe(fastStartValue);
			expect(mockDownload).toHaveBeenCalledOnce();
			const destination = mockDownload.mock.calls[0][0].destination;
			expect(typeof destination).toBe("string");
			expect(destination.endsWith(".m4a")).toBe(true);

			const probePath = result.openProbeInput();
			const transcodePath = result.openTranscodeInput();
			expect(probePath).toBe(destination);
			expect(transcodePath).toBe(destination);
		});

		it("cleanup unlinks the downloaded temp file", async () => {
			mockCreateReadStream.mockReturnValueOnce(makePrefixStream());
			mockIsFastStart.mockReturnValue(fastStartValue);

			const result = await prepareInputSource(makeSourceFile());
			await result.cleanup();

			expect(mockUnlink).toHaveBeenCalledWith(result.openProbeInput());
		});

		it("cleanup swallows unlink errors", async () => {
			mockCreateReadStream.mockReturnValueOnce(makePrefixStream());
			mockIsFastStart.mockReturnValue(fastStartValue);
			mockUnlink.mockRejectedValueOnce(new Error("ENOENT"));

			const result = await prepareInputSource(makeSourceFile());

			await expect(result.cleanup()).resolves.toBeUndefined();
		});

		it("rejects with a TransientError when the download fails", async () => {
			mockCreateReadStream.mockReturnValue(makePrefixStream());
			mockIsFastStart.mockReturnValue(fastStartValue);
			mockDownload.mockRejectedValue(new Error("ECONNRESET"));

			await expect(prepareInputSource(makeSourceFile())).rejects.toThrow(
				"source download error: ECONNRESET",
			);
			await expect(prepareInputSource(makeSourceFile())).rejects.toBeInstanceOf(
				TransientError,
			);
		});

		it("classifies a 404 download failure as permanent, not transient", async () => {
			mockCreateReadStream.mockReturnValue(makePrefixStream());
			mockIsFastStart.mockReturnValue(fastStartValue);
			const notFound = new Error("Not Found");
			notFound.status = 404;
			mockDownload.mockRejectedValue(notFound);

			await expect(
				prepareInputSource(makeSourceFile()),
			).rejects.not.toBeInstanceOf(TransientError);
		});
	});
});
