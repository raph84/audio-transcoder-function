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
});
