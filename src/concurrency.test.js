import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

function deferred() {
	let resolve;
	const promise = new Promise((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// Drains the microtask queue (unlike `await Promise.resolve()`, which only
// advances it by one tick) so pending `.then`/`await` chains settle fully
// before the next assertion.
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("mapWithConcurrency", () => {
	it("resolves fulfilled results in item order", async () => {
		const results = await mapWithConcurrency([1, 2, 3], 3, async (n) => n * 2);
		expect(results).toEqual([
			{ status: "fulfilled", value: 2 },
			{ status: "fulfilled", value: 4 },
			{ status: "fulfilled", value: 6 },
		]);
	});

	it("never runs more than `limit` calls at once", async () => {
		const items = [1, 2, 3, 4, 5];
		let active = 0;
		let maxActive = 0;
		const gates = items.map(() => deferred());

		const resultsPromise = mapWithConcurrency(items, 2, async (_item, i) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await gates[i].promise;
			active--;
			return i;
		});

		// Let the initial batch of workers start synchronously.
		await flush();
		expect(active).toBe(2);

		// Release gates one at a time; active count must never exceed 2.
		for (const gate of gates) {
			gate.resolve();
			await flush();
		}

		await resultsPromise;
		expect(maxActive).toBe(2);
	});

	it("attempts every item even when some reject, without throwing", async () => {
		const results = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
			if (n === 2) throw new Error("boom");
			return n;
		});

		expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
		expect(results[1].status).toBe("rejected");
		expect(results[1].reason.message).toBe("boom");
		expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
	});

	it("caps concurrency at items.length when limit is larger", async () => {
		const results = await mapWithConcurrency([1, 2], 10, async (n) => n);
		expect(results).toEqual([
			{ status: "fulfilled", value: 1 },
			{ status: "fulfilled", value: 2 },
		]);
	});

	it("resolves an empty array for empty input", async () => {
		const results = await mapWithConcurrency([], 4, async () => {
			throw new Error("should never be called");
		});
		expect(results).toEqual([]);
	});
});
