import { createHash } from "node:crypto";

export function mulberry32(seed: string): () => number {
	let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}

export function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Nearest-rank percentile: the value at rank ceil(q * n), clamped to the ends, on a sorted array. */
export function nearestRank(sorted: number[], q: number): number {
	const rank = Math.min(
		sorted.length,
		Math.max(1, Math.ceil(q * sorted.length)),
	);
	return sorted[rank - 1] as number;
}

export interface BootstrapInterval {
	mean: number;
	lo: number;
	hi: number;
	n: number;
}

/** Percentile bootstrap of the mean paired difference `a - b`, resampling whole PRs. */
export function pairedBootstrap(
	pairs: { a: number; b: number }[],
	opts: { level: number; resamples: number; seed: string },
): BootstrapInterval {
	const n = pairs.length;
	if (n === 0)
		return { mean: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 };
	const diffs = pairs.map((p) => p.a - p.b);
	const mean = diffs.reduce((s, d) => s + d, 0) / n;
	const rand = mulberry32(opts.seed);
	const means: number[] = [];
	for (let r = 0; r < opts.resamples; r++) {
		let sum = 0;
		for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)] as number;
		means.push(sum / n);
	}
	means.sort((x, y) => x - y);
	const alpha = (1 - opts.level) / 2;
	return {
		mean,
		lo: nearestRank(means, alpha),
		hi: nearestRank(means, 1 - alpha),
		n,
	};
}
