import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("exports default OUTPUT_FORMAT of flac", async () => {
		const { OUTPUT_FORMAT } = await import("./config.js");
		expect(OUTPUT_FORMAT).toBe("flac");
	});

	it("exports default OUTPUT_BUCKET of null", async () => {
		const { OUTPUT_BUCKET } = await import("./config.js");
		expect(OUTPUT_BUCKET).toBeNull();
	});

	it("exports default SOURCE_PREFIX of source/", async () => {
		const { SOURCE_PREFIX } = await import("./config.js");
		expect(SOURCE_PREFIX).toBe("source/");
	});

	it("exports default OUTPUT_PREFIX of transcoded/", async () => {
		const { OUTPUT_PREFIX } = await import("./config.js");
		expect(OUTPUT_PREFIX).toBe("transcoded/");
	});

	it("reads OUTPUT_BUCKET from env", async () => {
		vi.stubEnv("OUTPUT_BUCKET", "my-output-bucket");
		const { OUTPUT_BUCKET } = await import("./config.js");
		expect(OUTPUT_BUCKET).toBe("my-output-bucket");
	});

	it("treats empty-string OUTPUT_BUCKET as null", async () => {
		vi.stubEnv("OUTPUT_BUCKET", "");
		const { OUTPUT_BUCKET } = await import("./config.js");
		expect(OUTPUT_BUCKET).toBeNull();
	});

	it("reads SOURCE_PREFIX from env", async () => {
		vi.stubEnv("SOURCE_PREFIX", "uploads/");
		const { SOURCE_PREFIX } = await import("./config.js");
		expect(SOURCE_PREFIX).toBe("uploads/");
	});

	it("reads OUTPUT_PREFIX from env", async () => {
		vi.stubEnv("OUTPUT_PREFIX", "processed/");
		const { OUTPUT_PREFIX } = await import("./config.js");
		expect(OUTPUT_PREFIX).toBe("processed/");
	});

	it("throws at load time for an unsupported OUTPUT_FORMAT", async () => {
		vi.stubEnv("OUTPUT_FORMAT", "mp3");
		await expect(import("./config.js")).rejects.toThrow(
			'Unsupported OUTPUT_FORMAT: "mp3"',
		);
	});

	it("exports default PART_LENGTH_SECONDS of null", async () => {
		const { PART_LENGTH_SECONDS } = await import("./config.js");
		expect(PART_LENGTH_SECONDS).toBeNull();
	});

	it("exports default PART_OVERLAP_SECONDS of 0", async () => {
		const { PART_OVERLAP_SECONDS } = await import("./config.js");
		expect(PART_OVERLAP_SECONDS).toBe(0);
	});

	it("reads PART_LENGTH_SECONDS from env as a number", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "120");
		const { PART_LENGTH_SECONDS } = await import("./config.js");
		expect(PART_LENGTH_SECONDS).toBe(120);
	});

	it("reads PART_OVERLAP_SECONDS from env as a number", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "120");
		vi.stubEnv("PART_OVERLAP_SECONDS", "15");
		const { PART_OVERLAP_SECONDS } = await import("./config.js");
		expect(PART_OVERLAP_SECONDS).toBe(15);
	});

	it("throws at load time for a non-numeric PART_LENGTH_SECONDS", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "abc");
		await expect(import("./config.js")).rejects.toThrow(
			'Invalid PART_LENGTH_SECONDS: "abc"',
		);
	});

	it("throws at load time for a zero PART_LENGTH_SECONDS", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "0");
		await expect(import("./config.js")).rejects.toThrow(
			"Invalid PART_LENGTH_SECONDS",
		);
	});

	it("throws at load time for a negative PART_LENGTH_SECONDS", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "-10");
		await expect(import("./config.js")).rejects.toThrow(
			"Invalid PART_LENGTH_SECONDS",
		);
	});

	it("throws at load time for a negative PART_OVERLAP_SECONDS", async () => {
		vi.stubEnv("PART_OVERLAP_SECONDS", "-1");
		await expect(import("./config.js")).rejects.toThrow(
			"Invalid PART_OVERLAP_SECONDS",
		);
	});

	it("throws at load time when PART_OVERLAP_SECONDS equals PART_LENGTH_SECONDS", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "120");
		vi.stubEnv("PART_OVERLAP_SECONDS", "120");
		await expect(import("./config.js")).rejects.toThrow(
			"PART_OVERLAP_SECONDS (120) must be less than PART_LENGTH_SECONDS (120)",
		);
	});

	it("throws at load time when PART_OVERLAP_SECONDS exceeds PART_LENGTH_SECONDS", async () => {
		vi.stubEnv("PART_LENGTH_SECONDS", "120");
		vi.stubEnv("PART_OVERLAP_SECONDS", "150");
		await expect(import("./config.js")).rejects.toThrow(
			"PART_OVERLAP_SECONDS (150) must be less than PART_LENGTH_SECONDS (120)",
		);
	});

	it("does not throw when only PART_OVERLAP_SECONDS is set and PART_LENGTH_SECONDS is unset", async () => {
		vi.stubEnv("PART_OVERLAP_SECONDS", "15");
		const { PART_LENGTH_SECONDS, PART_OVERLAP_SECONDS } = await import(
			"./config.js"
		);
		expect(PART_LENGTH_SECONDS).toBeNull();
		expect(PART_OVERLAP_SECONDS).toBe(15);
	});
});
