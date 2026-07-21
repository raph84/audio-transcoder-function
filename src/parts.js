/**
 * Compute the sliding-window segments for splitting audio into overlapping
 * parts.
 *
 * Segments start at 0 and advance by (partLengthSeconds - overlapSeconds)
 * each step; every segment is `partLengthSeconds` long except possibly the
 * last, which is clipped to `totalDurationSeconds`.
 *
 * Precondition (enforced by src/config.js at startup, re-checked here so
 * this function is safe to call/test standalone): overlapSeconds must be
 * less than partLengthSeconds, or the window would never advance.
 *
 * @param {number} totalDurationSeconds
 * @param {number} partLengthSeconds
 * @param {number} overlapSeconds
 * @returns {{ start: number, duration: number }[]} empty array if
 *   totalDurationSeconds is not finite/positive, or does not exceed
 *   partLengthSeconds (no split needed).
 */
export function computeParts(
	totalDurationSeconds,
	partLengthSeconds,
	overlapSeconds,
) {
	if (
		!Number.isFinite(totalDurationSeconds) ||
		totalDurationSeconds <= 0 ||
		totalDurationSeconds <= partLengthSeconds
	) {
		return [];
	}

	const step = partLengthSeconds - overlapSeconds;
	if (!(step > 0)) {
		throw new Error(
			`computeParts: overlapSeconds (${overlapSeconds}) must be less than partLengthSeconds (${partLengthSeconds})`,
		);
	}

	const parts = [];
	let start = 0;
	while (start < totalDurationSeconds) {
		const end = Math.min(start + partLengthSeconds, totalDurationSeconds);
		parts.push({ start, duration: end - start });
		if (end >= totalDurationSeconds) break;
		start += step;
	}
	return parts;
}
