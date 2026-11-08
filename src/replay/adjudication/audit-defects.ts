import { createHash } from "node:crypto";
import type { AuditStored } from "./audit.js";
import type { VerdictCache } from "./cache.js";

export function labelsHashOf(labelsText: string): string {
	return createHash("sha256").update(labelsText).digest("hex").slice(0, 16);
}

export function auditDefectsFor(
	cache: VerdictCache<AuditStored>,
	snapshot: string,
	labelsHash: string,
): { path: string; line: number; title: string }[] {
	const prefix = `audit:${labelsHash}:`;
	const out: { path: string; line: number; title: string }[] = [];
	for (const [key, r] of cache.entries(snapshot)) {
		if (!key.startsWith(prefix) || r.kind !== "audit") continue;
		if (r.status !== "agreed" && r.status !== "single-family") continue;
		if (r.path === null || r.line === null) continue;
		out.push({ path: r.path, line: r.line, title: r.title });
	}
	return out;
}
