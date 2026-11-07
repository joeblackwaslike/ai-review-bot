export interface MapOptions {
	/** Called with the item index just before its worker starts — use for pacing/sleep. */
	onBeforeEach?: (index: number) => Promise<void> | void;
	/** Finish item 0 alone before the pool starts, so a prompt-cache write it
	 * makes is readable by the items that share its prefix. */
	serialFirst?: boolean;
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

	async function runItem(i: number): Promise<void> {
		if (opts.onBeforeEach) await opts.onBeforeEach(i);
		results[i] = await fn(items[i], i);
	}

	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			await runItem(i);
		}
	}

	if (opts.serialFirst && items.length > 0) {
		next = 1;
		await runItem(0);
	}
	await Promise.all(Array.from({ length: width }, () => worker()));
	return results;
}

/**
 * Like `mapWithConcurrency` with `serialFirst`, once per group: groups run one
 * after another in first-appearance order so each group's first item can warm
 * a cache that only that group shares. Results keep input order, and `fn` and
 * `onBeforeEach` see the item's index in the whole input.
 */
export async function mapWithConcurrencyByGroup<T, R>(
	items: readonly T[],
	groupOf: (item: T) => string,
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	opts: { onBeforeEach?: (index: number) => Promise<void> | void } = {},
): Promise<R[]> {
	const groups = new Map<string, number[]>();
	items.forEach((item, i) => {
		const key = groupOf(item);
		groups.set(key, [...(groups.get(key) ?? []), i]);
	});
	const results = new Array<R>(items.length);
	for (const indexes of groups.values()) {
		const out = await mapWithConcurrency(
			indexes,
			limit,
			(i) => fn(items[i] as T, i),
			{
				serialFirst: true,
				onBeforeEach: opts.onBeforeEach
					? (n) => opts.onBeforeEach?.(indexes[n] as number)
					: undefined,
			},
		);
		indexes.forEach((i, n) => {
			results[i] = out[n] as R;
		});
	}
	return results;
}
