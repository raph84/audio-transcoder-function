import { describe, expect, it } from "vitest";
import { computeParts } from "./parts.js";

describe("computeParts", () => {
	it("returns an empty array when totalDurationSeconds equals partLengthSeconds", () => {
		expect(computeParts(120, 120, 0)).toEqual([]);
	});

	it("returns an empty array when totalDurationSeconds is shorter than partLengthSeconds", () => {
		expect(computeParts(60, 120, 0)).toEqual([]);
	});

	it("returns an empty array for non-finite totalDurationSeconds", () => {
		expect(computeParts(Number.NaN, 120, 0)).toEqual([]);
		expect(computeParts(Number.POSITIVE_INFINITY, 120, 0)).toEqual([]);
	});

	it("returns an empty array for zero or negative totalDurationSeconds", () => {
		expect(computeParts(0, 120, 0)).toEqual([]);
		expect(computeParts(-10, 120, 0)).toEqual([]);
	});

	it("splits an exact multiple of partLengthSeconds with no overlap", () => {
		expect(computeParts(240, 120, 0)).toEqual([
			{ start: 0, duration: 120 },
			{ start: 120, duration: 120 },
		]);
	});

	it("clips a tiny trailing remainder with no overlap", () => {
		expect(computeParts(125, 120, 0)).toEqual([
			{ start: 0, duration: 120 },
			{ start: 120, duration: 5 },
		]);
	});

	it("produces a short second part for a one-second remainder", () => {
		expect(computeParts(121, 120, 0)).toEqual([
			{ start: 0, duration: 120 },
			{ start: 120, duration: 1 },
		]);
	});

	it("advances by (partLength - overlap) between consecutive parts", () => {
		expect(computeParts(300, 120, 15)).toEqual([
			{ start: 0, duration: 120 },
			{ start: 105, duration: 120 },
			{ start: 210, duration: 90 },
		]);
	});

	it("throws when overlapSeconds is greater than or equal to partLengthSeconds", () => {
		expect(() => computeParts(300, 120, 120)).toThrow(
			"overlapSeconds (120) must be less than partLengthSeconds (120)",
		);
		expect(() => computeParts(300, 120, 150)).toThrow(
			"overlapSeconds (150) must be less than partLengthSeconds (120)",
		);
	});
});
