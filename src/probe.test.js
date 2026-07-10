import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before vi.mock factories, making cap available inside the factory.
const cap = vi.hoisted(() => ({ ffprobeCallback: null }));

vi.mock("fluent-ffmpeg", () => {
	const mock = Object.assign(vi.fn(), {
		setFfmpegPath: vi.fn(),
		setFfprobePath: vi.fn(),
		ffprobe: vi.fn((_stream, cb) => {
			cap.ffprobeCallback = cb;
		}),
	});
	return { default: mock };
});

vi.mock("ffmpeg-static", () => ({ default: "/mock/ffmpeg" }));
vi.mock("@ffprobe-installer/ffprobe", () => ({
	default: { path: "/mock/ffprobe" },
}));

import { TransientError } from "./errors.js";
import { probeAudio } from "./probe.js";

function makeStream() {
	return new Readable({ read() {} });
}

describe("probeAudio", () => {
	beforeEach(() => {
		cap.ffprobeCallback = null;
	});

	it("resolves with codec, sampleRate, and channels from the audio stream", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(null, {
			streams: [
				{
					codec_type: "audio",
					codec_name: "aac",
					sample_rate: "44100",
					channels: 2,
				},
			],
		});

		await expect(promise).resolves.toEqual({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
	});

	it("coerces sample_rate string to a number", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(null, {
			streams: [
				{
					codec_type: "audio",
					codec_name: "pcm_s16le",
					sample_rate: "8000",
					channels: 1,
				},
			],
		});

		const result = await promise;
		expect(typeof result.sampleRate).toBe("number");
		expect(result.sampleRate).toBe(8000);
	});

	it("picks the first audio stream and ignores non-audio streams", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(null, {
			streams: [
				{ codec_type: "video", codec_name: "h264" },
				{
					codec_type: "audio",
					codec_name: "aac",
					sample_rate: "44100",
					channels: 2,
				},
			],
		});

		const result = await promise;
		expect(result.codec).toBe("aac");
	});

	it("rejects when the file contains no audio stream", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(null, { streams: [] });

		await expect(promise).rejects.toThrow(
			"No audio stream found in source file",
		);
	});

	it("rejects when streams property is absent", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(null, {});

		await expect(promise).rejects.toThrow(
			"No audio stream found in source file",
		);
	});

	it("rejects and wraps the ffprobe error message", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(new Error("no such file or directory"));

		await expect(promise).rejects.toThrow(
			"ffprobe failed: no such file or directory",
		);
	});

	it("rejects with a plain (non-transient) error on ffprobe decode failure", async () => {
		const promise = probeAudio(makeStream());

		cap.ffprobeCallback(new Error("invalid data found"));

		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("rejects with a TransientError when the source stream errors", async () => {
		const stream = makeStream();
		const promise = probeAudio(stream);

		stream.emit("error", new Error("ECONNRESET"));

		await expect(promise).rejects.toBeInstanceOf(TransientError);
		await expect(promise).rejects.toThrow(
			"source read stream error: ECONNRESET",
		);
	});

	it("ignores a late ffprobe callback after the stream already errored", async () => {
		const stream = makeStream();
		const promise = probeAudio(stream);

		stream.emit("error", new Error("ECONNRESET"));
		cap.ffprobeCallback(null, {
			streams: [
				{
					codec_type: "audio",
					codec_name: "aac",
					sample_rate: "44100",
					channels: 2,
				},
			],
		});

		await expect(promise).rejects.toBeInstanceOf(TransientError);
	});
});
