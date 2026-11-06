import { createHash } from "node:crypto";
import { claimTokens } from "../../claim-dedupe.js";
import type { ReplayFixture } from "../types.js";

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([key]) => key !== "trace")
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, v]) => [key, canonical(v)]),
		);
	}
	return value;
}

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

export function snapshotId(fixture: ReplayFixture): string {
	return sha256(JSON.stringify(canonical(fixture))).slice(0, 16);
}

export function claimKey(c: { path: string | null; title: string }): string {
	const tokens = [...claimTokens(c.title)].sort();
	return sha256(JSON.stringify([c.path, tokens]));
}
