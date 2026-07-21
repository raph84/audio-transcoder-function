/**
 * Run `fn` over `items` with at most `limit` calls in flight at once. Every
 * item is attempted regardless of earlier failures - a rejection settles
 * that item's slot but doesn't stop the rest, mirroring `Promise.allSettled`
 * shape/semantics rather than `Promise.all`'s fail-fast behavior.
 *
 * Used by index.js to bound how many split parts transcode concurrently:
 * each part is a full ffmpeg decode (CPU-bound), so unbounded concurrency
 * would let a long recording with many parts launch an unbounded number of
 * simultaneous decodes within one invocation.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ status: 'fulfilled', value: R } | { status: 'rejected', reason: unknown }>>}
 */
export async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;

	async function worker() {
		while (next < items.length) {
			const i = next++;
			try {
				results[i] = { status: "fulfilled", value: await fn(items[i], i) };
			} catch (reason) {
				results[i] = { status: "rejected", reason };
			}
		}
	}

	const workerCount = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workerCount }, worker));

	return results;
}
