/**
 * Determine whether an MP4/M4A file is faststart by walking its top-level
 * boxes and checking which comes first: `moov` (faststart) or `mdat`
 * (non-faststart). Only box headers need to be inspected — `moov`'s
 * contents are never read — so a small leading slice of the file is enough
 * in the vast majority of cases.
 *
 * @param {Buffer} buffer leading bytes of the file (see PREFIX_BYTES)
 * @returns {boolean|null} true if faststart, false if not, null if the
 *   prefix was exhausted before either box was found (inconclusive).
 */
export function isFastStart(buffer) {
	let offset = 0;
	const n = buffer.length;

	while (offset + 8 <= n) {
		let size = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);

		if (size === 1) {
			if (offset + 16 > n) return null;
			size = Number(buffer.readBigUInt64BE(offset + 8));
		}

		if (type === "moov") return true;
		if (type === "mdat") return false;
		if (size === 0) return null; // box extends to EOF; neither found yet

		offset += size;
	}

	return null;
}

/** Bytes of leading file data read to make the faststart determination. */
export const PREFIX_BYTES = 65536;
