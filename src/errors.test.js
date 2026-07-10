import { describe, expect, it } from "vitest";
import { isTransientError, TransientError } from "./errors.js";

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
