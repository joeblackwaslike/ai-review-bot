import { Redis } from "@upstash/redis";

/** The minimal Redis surface the feedback store needs. Score bounds accept numbers or the
 * Redis tokens "-inf"/"+inf"/"(123" (exclusive). Values are opaque strings (callers JSON-encode). */
export interface KvClient {
	zadd(key: string, score: number, member: string): Promise<unknown>;
	zrangebyscore(
		key: string,
		min: number | string,
		max: number | string,
	): Promise<string[]>;
	zremrangebyscore(
		key: string,
		min: number | string,
		max: number | string,
	): Promise<number>;
	set(key: string, value: string, ttlSeconds?: number): Promise<unknown>;
	/** Atomic claim: set key to value only if it does not already exist, with a TTL.
	 * Returns true if the key was set (claim acquired), false if it already existed. */
	setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
	get(key: string): Promise<string | null>;
	del(...keys: string[]): Promise<unknown>;
	lpush(key: string, value: string): Promise<unknown>;
}

export function createUpstashKv(): KvClient {
	const url = process.env.KV_REST_API_URL;
	const token = process.env.KV_REST_API_TOKEN;
	if (!url || !token) {
		throw new Error(
			"KV_REST_API_URL and KV_REST_API_TOKEN are required when FEEDBACK_ENABLED=true",
		);
	}
	// automaticDeserialization:false keeps values as the raw strings we JSON-encode.
	const redis = new Redis({ url, token, automaticDeserialization: false });
	return {
		zadd: (key, score, member) => redis.zadd(key, { score, member }),
		// zrange with byScore:true requires the narrow token union to hit the byScore overload.
		zrangebyscore: (key, min, max) =>
			redis.zrange(
				key,
				min as number | `(${number}` | "-inf" | "+inf",
				max as number | `(${number}` | "-inf" | "+inf",
				{ byScore: true },
			) as Promise<string[]>,
		zremrangebyscore: (key, min, max) =>
			redis.zremrangebyscore(
				key,
				min as number | `(${number}` | "-inf" | "+inf",
				max as number | `(${number}` | "-inf" | "+inf",
			),
		set: (key, value, ttlSeconds) =>
			ttlSeconds
				? redis.set(key, value, { ex: ttlSeconds })
				: redis.set(key, value),
		setNx: async (key, value, ttlSeconds) =>
			(await redis.set(key, value, { nx: true, ex: ttlSeconds })) === "OK",
		get: (key) => redis.get<string>(key),
		del: (...keys) => redis.del(...keys),
		lpush: (key, value) => redis.lpush(key, value),
	};
}
