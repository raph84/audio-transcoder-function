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

	// --- SPLIT_AFTER_MINUTES ---

	it("exports default SPLIT_AFTER_MINUTES of null", async () => {
		const { SPLIT_AFTER_MINUTES } = await import("./config.js");
		expect(SPLIT_AFTER_MINUTES).toBeNull();
	});

	it("reads and parses SPLIT_AFTER_MINUTES from env", async () => {
		vi.stubEnv("SPLIT_AFTER_MINUTES", "60");
		const { SPLIT_AFTER_MINUTES } = await import("./config.js");
		expect(SPLIT_AFTER_MINUTES).toBe(60);
	});

	it("treats empty-string SPLIT_AFTER_MINUTES as null", async () => {
		vi.stubEnv("SPLIT_AFTER_MINUTES", "");
		const { SPLIT_AFTER_MINUTES } = await import("./config.js");
		expect(SPLIT_AFTER_MINUTES).toBeNull();
	});

	it.each([
		"abc",
		"0",
		"-5",
		"Infinity",
		"NaN",
	])("throws at load time for an invalid SPLIT_AFTER_MINUTES value %s", async (value) => {
		vi.stubEnv("SPLIT_AFTER_MINUTES", value);
		await expect(import("./config.js")).rejects.toThrow(
			"SPLIT_AFTER_MINUTES must be a positive finite number",
		);
	});

	// --- SILENCE_NOISE_DB ---

	it("exports default SILENCE_NOISE_DB of -30", async () => {
		const { SILENCE_NOISE_DB } = await import("./config.js");
		expect(SILENCE_NOISE_DB).toBe(-30);
	});

	it("reads SILENCE_NOISE_DB from env", async () => {
		vi.stubEnv("SILENCE_NOISE_DB", "-40");
		const { SILENCE_NOISE_DB } = await import("./config.js");
		expect(SILENCE_NOISE_DB).toBe(-40);
	});

	it("throws at load time for a non-finite SILENCE_NOISE_DB", async () => {
		vi.stubEnv("SILENCE_NOISE_DB", "abc");
		await expect(import("./config.js")).rejects.toThrow(
			"SILENCE_NOISE_DB must be a finite number",
		);
	});

	it("treats empty-string SILENCE_NOISE_DB as unset (uses default -30, not 0)", async () => {
		vi.stubEnv("SILENCE_NOISE_DB", "");
		const { SILENCE_NOISE_DB } = await import("./config.js");
		expect(SILENCE_NOISE_DB).toBe(-30);
	});

	// --- SILENCE_MIN_DURATION_SECONDS ---

	it("exports default SILENCE_MIN_DURATION_SECONDS of 0.5", async () => {
		const { SILENCE_MIN_DURATION_SECONDS } = await import("./config.js");
		expect(SILENCE_MIN_DURATION_SECONDS).toBe(0.5);
	});

	it("reads SILENCE_MIN_DURATION_SECONDS from env", async () => {
		vi.stubEnv("SILENCE_MIN_DURATION_SECONDS", "1.5");
		const { SILENCE_MIN_DURATION_SECONDS } = await import("./config.js");
		expect(SILENCE_MIN_DURATION_SECONDS).toBe(1.5);
	});

	it.each([
		"abc",
		"0",
		"-1",
	])("throws at load time for an invalid SILENCE_MIN_DURATION_SECONDS value %s", async (value) => {
		vi.stubEnv("SILENCE_MIN_DURATION_SECONDS", value);
		await expect(import("./config.js")).rejects.toThrow(
			"SILENCE_MIN_DURATION_SECONDS must be a positive finite number",
		);
	});

	it("treats empty-string SILENCE_MIN_DURATION_SECONDS as unset (uses default 0.5)", async () => {
		vi.stubEnv("SILENCE_MIN_DURATION_SECONDS", "");
		const { SILENCE_MIN_DURATION_SECONDS } = await import("./config.js");
		expect(SILENCE_MIN_DURATION_SECONDS).toBe(0.5);
	});

	// --- SILENCE_LOOKBACK_MAX_SECONDS ---

	it("defaults SILENCE_LOOKBACK_MAX_SECONDS to 120 when SPLIT_AFTER_MINUTES is unset", async () => {
		const { SILENCE_LOOKBACK_MAX_SECONDS } = await import("./config.js");
		expect(SILENCE_LOOKBACK_MAX_SECONDS).toBe(120);
	});

	it("defaults SILENCE_LOOKBACK_MAX_SECONDS to 25% of the split interval when under the cap", async () => {
		vi.stubEnv("SPLIT_AFTER_MINUTES", "10"); // 10*60*0.25 = 150, capped? no: 150 > 120
		const { SILENCE_LOOKBACK_MAX_SECONDS } = await import("./config.js");
		// 10 min -> 600s * 0.25 = 150s, clamped to the 120s cap
		expect(SILENCE_LOOKBACK_MAX_SECONDS).toBe(120);
	});

	it("clamps the default SILENCE_LOOKBACK_MAX_SECONDS to a fraction of a small split interval", async () => {
		vi.stubEnv("SPLIT_AFTER_MINUTES", "2"); // 2*60*0.25 = 30, well under the cap
		const { SILENCE_LOOKBACK_MAX_SECONDS } = await import("./config.js");
		expect(SILENCE_LOOKBACK_MAX_SECONDS).toBe(30);
	});

	it("reads an explicit SILENCE_LOOKBACK_MAX_SECONDS override regardless of SPLIT_AFTER_MINUTES", async () => {
		vi.stubEnv("SPLIT_AFTER_MINUTES", "60");
		vi.stubEnv("SILENCE_LOOKBACK_MAX_SECONDS", "45");
		const { SILENCE_LOOKBACK_MAX_SECONDS } = await import("./config.js");
		expect(SILENCE_LOOKBACK_MAX_SECONDS).toBe(45);
	});

	it.each([
		"abc",
		"0",
		"-1",
	])("throws at load time for an invalid SILENCE_LOOKBACK_MAX_SECONDS value %s", async (value) => {
		vi.stubEnv("SILENCE_LOOKBACK_MAX_SECONDS", value);
		await expect(import("./config.js")).rejects.toThrow(
			"SILENCE_LOOKBACK_MAX_SECONDS must be a positive finite number",
		);
	});

	// --- SPLIT_PART_CONCURRENCY ---

	it("exports default SPLIT_PART_CONCURRENCY of 4", async () => {
		const { SPLIT_PART_CONCURRENCY } = await import("./config.js");
		expect(SPLIT_PART_CONCURRENCY).toBe(4);
	});

	it("reads SPLIT_PART_CONCURRENCY from env", async () => {
		vi.stubEnv("SPLIT_PART_CONCURRENCY", "2");
		const { SPLIT_PART_CONCURRENCY } = await import("./config.js");
		expect(SPLIT_PART_CONCURRENCY).toBe(2);
	});

	it("treats empty-string SPLIT_PART_CONCURRENCY as unset (uses default 4)", async () => {
		vi.stubEnv("SPLIT_PART_CONCURRENCY", "");
		const { SPLIT_PART_CONCURRENCY } = await import("./config.js");
		expect(SPLIT_PART_CONCURRENCY).toBe(4);
	});

	it.each([
		"abc",
		"0",
		"-1",
		"1.5",
	])("throws at load time for an invalid SPLIT_PART_CONCURRENCY value %s", async (value) => {
		vi.stubEnv("SPLIT_PART_CONCURRENCY", value);
		await expect(import("./config.js")).rejects.toThrow(
			"SPLIT_PART_CONCURRENCY must be a positive integer",
		);
	});
});
