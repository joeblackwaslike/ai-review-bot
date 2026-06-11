import type { KvClient } from "./kv.js";

/** Parse a Redis score bound: number, "-inf"/"+inf", or exclusive "(123". */
function parseBound(v: number | string): { value: number; exclusive: boolean } {
	if (typeof v === "number") return { value: v, exclusive: false };
	if (v === "-inf")
		return { value: Number.NEGATIVE_INFINITY, exclusive: false };
	if (v === "+inf")
		return { value: Number.POSITIVE_INFINITY, exclusive: false };
	if (v.startsWith("(")) return { value: Number(v.slice(1)), exclusive: true };
	return { value: Number(v), exclusive: false };
}

export interface FakeKv extends KvClient {
	_dump(): {
		strings: Map<string, string>;
		zsets: Map<string, Map<string, number>>;
		lists: Map<string, string[]>;
	};
}

export function createFakeKv(): FakeKv {
	const strings = new Map<string, string>();
	const zsets = new Map<string, Map<string, number>>();
	const lists = new Map<string, string[]>();

	function inRange(
		score: number,
		min: number | string,
		max: number | string,
	): boolean {
		const lo = parseBound(min);
		const hi = parseBound(max);
		const aboveLo = lo.exclusive ? score > lo.value : score >= lo.value;
		const belowHi = hi.exclusive ? score < hi.value : score <= hi.value;
		return aboveLo && belowHi;
	}

	return {
		async zadd(key, score, member) {
			let z = zsets.get(key);
			if (!z) {
				z = new Map();
				zsets.set(key, z);
			}
			z.set(member, score);
		},
		async zrangebyscore(key, min, max) {
			const z = zsets.get(key) ?? new Map<string, number>();
			return [...z.entries()]
				.filter(([, s]) => inRange(s, min, max))
				.sort((a, b) => a[1] - b[1])
				.map(([m]) => m);
		},
		async zremrangebyscore(key, min, max) {
			const z = zsets.get(key);
			if (!z) return 0;
			let n = 0;
			for (const [m, s] of [...z.entries()]) {
				if (inRange(s, min, max)) {
					z.delete(m);
					n++;
				}
			}
			return n;
		},
		async set(key, value) {
			strings.set(key, value);
		},
		async get(key) {
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async del(...keys) {
			for (const k of keys) strings.delete(k);
		},
		async lpush(key, value) {
			const l = lists.get(key) ?? [];
			l.unshift(value);
			lists.set(key, l);
		},
		_dump() {
			return { strings, zsets, lists };
		},
	};
}
