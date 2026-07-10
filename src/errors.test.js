import { describe, expect, it } from "vitest";
import {
	classifyGcsStreamError,
	isTransientError,
	TransientError,
} from "./errors.js";

describe("TransientError / isTransientError", () => {
	it("is an Error subclass carrying the given message", () => {
		const err = new TransientError("boom");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("boom");
		expect(err.name).toBe("TransientError");
	});

	it("isTransientError returns true for a TransientError", () => {
		expect(isTransientError(new TransientError("boom"))).toBe(true);
	});

	it("isTransientError returns false for a plain Error", () => {
		expect(isTransientError(new Error("boom"))).toBe(false);
	});
});

describe("classifyGcsStreamError", () => {
	it("wraps an error with no HTTP status as TransientError", () => {
		const result = classifyGcsStreamError(new Error("ECONNRESET"), "prefix");
		expect(result).toBeInstanceOf(TransientError);
		expect(result.message).toBe("prefix: ECONNRESET");
	});

	it.each([
		500, 502, 503, 429,
	])("treats HTTP status %i as transient", (status) => {
		const err = new Error("server error");
		err.status = status;
		expect(classifyGcsStreamError(err, "prefix")).toBeInstanceOf(
			TransientError,
		);
	});

	it.each([
		400, 401, 403, 404, 409, 412,
	])("treats HTTP status %i as permanent", (status) => {
		const err = new Error("client error");
		err.status = status;
		const result = classifyGcsStreamError(err, "prefix");
		expect(result).not.toBeInstanceOf(TransientError);
		expect(result.message).toBe("prefix: client error");
	});
});
