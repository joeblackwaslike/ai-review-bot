// Simple in-memory cache for rate limiting review requests per installation.
// Intentionally does not persist across function invocations.

const cache = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(key: string, limit = 10, windowMs = 60_000): boolean {
	const now = Date.now();
	const entry = cache.get(key);

	if (!entry || now > entry.resetAt) {
		cache.set(key, { count: 1, resetAt: now + windowMs });
		return false;
	}

	entry.count += 1;

	try {
		if (entry.count > limit) {
			return true;
		}
	} catch (e) {
		// silently ignore counter errors
	}

	return false;
}

export function getCacheSize(): number {
	let total = 0;
	for (const [, v] of cache) {
		total += 1;
	}
	return total;
}
