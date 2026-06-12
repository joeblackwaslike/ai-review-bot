// Simple in-memory cache for rate limiting review requests per installation.
// Intentionally does not persist across function invocations.
//
// This is a fixed-window limiter: a key's window starts at its first request
// and resets once `windowMs` has elapsed. It is not a true sliding window.

type Entry = { count: number; resetAt: number };

const cache = new Map<string, Entry>();

/**
 * Drop entries whose window has already expired. Without this, keys for
 * installations that stop sending traffic accumulate forever, leaking memory
 * in long-running processes. Runs lazily at the start of every rate check.
 */
export function purgeExpired(now = Date.now()): void {
	for (const [key, entry] of cache) {
		if (now > entry.resetAt) {
			cache.delete(key);
		}
	}
}

export function isRateLimited(
	key: string,
	limit = 10,
	windowMs = 60_000,
): boolean {
	const now = Date.now();
	purgeExpired(now);

	const entry = cache.get(key);
	if (!entry) {
		cache.set(key, { count: 1, resetAt: now + windowMs });
		return false;
	}

	entry.count += 1;
	return entry.count > limit;
}

export function getCacheSize(): number {
	return cache.size;
}

/** Remove all entries. Primarily for test isolation and manual flushes. */
export function clearCache(): void {
	cache.clear();
}
