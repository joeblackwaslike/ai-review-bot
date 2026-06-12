export interface MapOptions {
	/** Called with the item index just before its worker starts — use for pacing/sleep. */
	onBeforeEach?: (index: number) => Promise<void> | void;
}

/**
 * Run `fn` over `items` with at most `limit` concurrent workers; results keep input order.
 * If `fn` or `onBeforeEach` rejects, the returned promise rejects (errors are not swallowed).
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	opts: MapOptions = {},
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length || 1));

	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			if (opts.onBeforeEach) await opts.onBeforeEach(i);
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(Array.from({ length: width }, () => worker()));
	return results;
}
