import { describe, expect, it } from "vitest";
import { isFastStart } from "./mp4.js";

function box(type, contents = Buffer.alloc(0)) {
	const size = 8 + contents.length;
	const header = Buffer.alloc(8);
	header.writeUInt32BE(size, 0);
	header.write(type, 4, "ascii");
	return Buffer.concat([header, contents]);
}

function box64(type, contents = Buffer.alloc(0)) {
	const size = 16 + contents.length;
	const header = Buffer.alloc(16);
	header.writeUInt32BE(1, 0);
	header.write(type, 4, "ascii");
	header.writeBigUInt64BE(BigInt(size), 8);
	return Buffer.concat([header, contents]);
}

describe("isFastStart", () => {
	it("returns true when moov comes before mdat (faststart)", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box("moov", Buffer.alloc(100)),
			box("mdat", Buffer.alloc(1000)),
		]);
		expect(isFastStart(buffer)).toBe(true);
	});

	it("returns false when mdat comes before moov (non-faststart)", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box("mdat", Buffer.alloc(1000)),
			box("moov", Buffer.alloc(100)),
		]);
		expect(isFastStart(buffer)).toBe(false);
	});

	it("skips over free/wide boxes before finding moov", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box("free", Buffer.alloc(8)),
			box("moov", Buffer.alloc(100)),
			box("mdat", Buffer.alloc(1000)),
		]);
		expect(isFastStart(buffer)).toBe(true);
	});

	it("only needs the mdat header, not its full contents, to decide", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box("mdat", Buffer.alloc(0)).subarray(0, 8), // header only, size lies about contents
		]);
		expect(isFastStart(buffer)).toBe(false);
	});

	it("handles 64-bit box sizes", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box64("mdat", Buffer.alloc(1000)),
			box("moov", Buffer.alloc(100)),
		]);
		expect(isFastStart(buffer)).toBe(false);
	});

	it("returns null when the prefix is exhausted before moov or mdat appear", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box("free", Buffer.alloc(8)),
		]);
		expect(isFastStart(buffer)).toBeNull();
	});

	it("returns null when a 64-bit size box's extended size field is truncated", () => {
		const buffer = Buffer.concat([
			box("ftyp", Buffer.alloc(16)),
			box64("mdat", Buffer.alloc(1000)).subarray(0, 10),
		]);
		expect(isFastStart(buffer)).toBeNull();
	});

	it("returns null when a box declares size 0 (extends to EOF) before either is found", () => {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(0, 0);
		header.write("free", 4, "ascii");
		const buffer = Buffer.concat([box("ftyp", Buffer.alloc(16)), header]);
		expect(isFastStart(buffer)).toBeNull();
	});

	it("returns null for an empty buffer", () => {
		expect(isFastStart(Buffer.alloc(0))).toBeNull();
	});
});
