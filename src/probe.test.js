import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before vi.mock factories, making state available inside them.
const state = vi.hoisted(() => ({ lastProc: null }));

function makeFakeProc() {
	const proc = new EventEmitter();
	proc.stdin = new Writable({
		write(_chunk, _enc, cb) {
			cb();
		},
	});
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	return proc;
}

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		state.lastProc = makeFakeProc();
		return state.lastProc;
	}),
}));

vi.mock("@ffprobe-installer/ffprobe", () => ({
	default: { path: "/mock/ffprobe" },
}));

import { TransientError } from "./errors.js";
import { probeAudio } from "./probe.js";

function makeStream() {
	return new Readable({ read() {} });
}

function emitStdout(json) {
	state.lastProc.stdout.emit("data", Buffer.from(json));
}

function close(code, signal = null) {
	state.lastProc.emit("close", code, signal);
}

const oneAudioStream = JSON.stringify({
	streams: [
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "44100",
			channels: 2,
		},
	],
});

describe("probeAudio", () => {
	beforeEach(() => {
		state.lastProc = null;
	});

	it("resolves with codec, sampleRate, and channels from the audio stream", async () => {
		const promise = probeAudio(makeStream());

		emitStdout(oneAudioStream);
		close(0);

		await expect(promise).resolves.toEqual({
			codec: "aac",
			sampleRate: 44100,
			channels: 2,
		});
	});

	it("coerces sample_rate string to a number", async () => {
		const promise = probeAudio(makeStream());

		emitStdout(
			JSON.stringify({
				streams: [
					{
						codec_type: "audio",
						codec_name: "pcm_s16le",
						sample_rate: "8000",
						channels: 1,
					},
				],
			}),
		);
		close(0);

		const result = await promise;
		expect(typeof result.sampleRate).toBe("number");
		expect(result.sampleRate).toBe(8000);
	});

	it("picks the first audio stream and ignores non-audio streams", async () => {
		const promise = probeAudio(makeStream());

		emitStdout(
			JSON.stringify({
				streams: [
					{ codec_type: "video", codec_name: "h264" },
					{
						codec_type: "audio",
						codec_name: "aac",
						sample_rate: "44100",
						channels: 2,
					},
				],
			}),
		);
		close(0);

		const result = await promise;
		expect(result.codec).toBe("aac");
	});

	it("rejects when the file contains no audio stream", async () => {
		const promise = probeAudio(makeStream());

		emitStdout(JSON.stringify({ streams: [] }));
		close(0);

		await expect(promise).rejects.toThrow(
			"No audio stream found in source file",
		);
	});

	it("rejects when streams property is absent", async () => {
		const promise = probeAudio(makeStream());

		emitStdout(JSON.stringify({}));
		close(0);

		await expect(promise).rejects.toThrow(
			"No audio stream found in source file",
		);
	});

	it("rejects with a plain (non-transient) error when ffprobe exits with a non-zero code", async () => {
		const promise = probeAudio(makeStream());

		state.lastProc.stderr.emit("data", Buffer.from("invalid data found"));
		close(1);

		await expect(promise).rejects.toThrow("ffprobe exited with code 1");
		await expect(promise).rejects.toThrow("invalid data found");
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("rejects with a plain (non-transient) error when ffprobe is killed by a signal", async () => {
		const promise = probeAudio(makeStream());

		close(null, "SIGSEGV");

		await expect(promise).rejects.toThrow("signal SIGSEGV");
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("rejects with a plain (non-transient) error when ffprobe produces invalid JSON", async () => {
		const promise = probeAudio(makeStream());

		emitStdout("not json");
		close(0);

		await expect(promise).rejects.toThrow("ffprobe produced invalid output");
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("rejects with a plain (non-transient) error when ffprobe fails to spawn", async () => {
		const promise = probeAudio(makeStream());

		state.lastProc.emit("error", new Error("ENOENT"));

		await expect(promise).rejects.toThrow("ffprobe failed to start: ENOENT");
		await expect(promise).rejects.not.toBeInstanceOf(TransientError);
	});

	it("rejects with a TransientError and kills ffprobe when the source stream errors", async () => {
		const stream = makeStream();
		const promise = probeAudio(stream);

		stream.emit("error", new Error("ECONNRESET"));

		await expect(promise).rejects.toBeInstanceOf(TransientError);
		await expect(promise).rejects.toThrow(
			"source read stream error: ECONNRESET",
		);
		expect(state.lastProc.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("ignores a late close event after the stream already errored", async () => {
		const stream = makeStream();
		const promise = probeAudio(stream);

		stream.emit("error", new Error("ECONNRESET"));
		emitStdout(oneAudioStream);
		close(0);

		await expect(promise).rejects.toBeInstanceOf(TransientError);
	});

	describe("when input is a local file path", () => {
		it("passes the path as ffprobe's input instead of pipe:0", async () => {
			probeAudio("/tmp/some-file.m4a");

			expect(state.lastProc).not.toBeNull();
			const { spawn } = await import("node:child_process");
			expect(spawn).toHaveBeenCalledWith(
				"/mock/ffprobe",
				["-print_format", "json", "-show_streams", "/tmp/some-file.m4a"],
				{ windowsHide: true },
			);
		});

		it("resolves with codec, sampleRate, and channels", async () => {
			const promise = probeAudio("/tmp/some-file.m4a");

			emitStdout(oneAudioStream);
			close(0);

			await expect(promise).resolves.toEqual({
				codec: "aac",
				sampleRate: 44100,
				channels: 2,
			});
		});

		it("rejects with a plain (non-transient) error when ffprobe exits with a non-zero code", async () => {
			const promise = probeAudio("/tmp/some-file.m4a");

			close(1);

			await expect(promise).rejects.toThrow("ffprobe exited with code 1");
			await expect(promise).rejects.not.toBeInstanceOf(TransientError);
		});
	});
});
