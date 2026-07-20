import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runFfmpegPipeline } from "./ffmpegPipeline.js";

function makeCommand() {
	const cmd = new EventEmitter();
	cmd.pipe = vi.fn((stream) => stream);
	return cmd;
}

function makeOutputStream() {
	return new EventEmitter();
}

describe("runFfmpegPipeline", () => {
	it("pipes the command into the output stream with { end: true }", () => {
		const command = makeCommand();
		const out = makeOutputStream();

		runFfmpegPipeline(command, out, {
			commandErrorLabel: "x",
			streamErrorLabel: "y",
		});

		expect(command.pipe).toHaveBeenCalledWith(out, { end: true });
	});

	it("resolves when the output stream emits finish", async () => {
		const command = makeCommand();
		const out = makeOutputStream();

		const promise = runFfmpegPipeline(command, out, {
			commandErrorLabel: "x",
			streamErrorLabel: "y",
		});

		out.emit("finish");

		await expect(promise).resolves.toBeUndefined();
	});

	it("rejects, wrapping the stderr tail, when the command emits an error", async () => {
		const command = makeCommand();
		const out = makeOutputStream();

		const promise = runFfmpegPipeline(command, out, {
			commandErrorLabel: "custom label",
			streamErrorLabel: "y",
		});

		command.emit("error", new Error("boom"), "", "stderr detail");

		await expect(promise).rejects.toThrow("custom label error: boom");
		await expect(promise).rejects.toThrow("stderr detail");
	});

	it("rejects when the output stream emits an error", async () => {
		const command = makeCommand();
		const out = makeOutputStream();

		const promise = runFfmpegPipeline(command, out, {
			commandErrorLabel: "x",
			streamErrorLabel: "custom stream label",
		});

		out.emit("error", new Error("upload aborted"));

		await expect(promise).rejects.toThrow(
			"custom stream label error: upload aborted",
		);
	});

	it("destroys the output stream when the command errors", async () => {
		const command = makeCommand();
		const out = makeOutputStream();
		out.destroy = vi.fn();

		const promise = runFfmpegPipeline(command, out, {
			commandErrorLabel: "x",
			streamErrorLabel: "y",
		});

		command.emit("error", new Error("boom"), "", "");
		await expect(promise).rejects.toThrow();

		expect(out.destroy).toHaveBeenCalled();
	});

	it("does not throw when the output stream has no destroy method", async () => {
		const command = makeCommand();
		const out = makeOutputStream(); // plain EventEmitter, no destroy()

		const promise = runFfmpegPipeline(command, out, {
			commandErrorLabel: "x",
			streamErrorLabel: "y",
		});

		command.emit("error", new Error("boom"), "", "");
		await expect(promise).rejects.toThrow();
	});

	it("settles only once when both a command error and a stream error fire", async () => {
		const command = makeCommand();
		const out = makeOutputStream();

		const promise = runFfmpegPipeline(command, out, {
			commandErrorLabel: "x",
			streamErrorLabel: "y",
		});

		command.emit("error", new Error("ffmpeg died"), "", "");
		out.emit("error", new Error("stream also died"));

		await expect(promise).rejects.toThrow("ffmpeg died");
	});
});
