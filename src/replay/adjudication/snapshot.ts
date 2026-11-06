import { createHash } from "node:crypto";
import { claimIdentifiers, claimTokens } from "../../claim-dedupe.js";
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

const NEGATION = /\b(?:not|no|never|without|neither|nor)\b/;
const NUMBER = /(?<![A-Za-z0-9_$.])\d+(?:\.\d+)?(?![A-Za-z0-9_$])/g;

/** Contractions and "cannot" are spelled out so "isn't" and "is not" read the same. */
const spellOutNegation = (title: string): string =>
	title
		.toLowerCase()
		.replace(/\bcannot\b/g, " not ")
		.replace(/\b(\w+)n't\b/g, "$1 not");

/**
 * Same path, same title words, same named identifiers, same negation and same numbers give the
 * same key. claimTokens drops negation words and short numbers, yet they flip a claim, so they
 * are keyed separately.
 */
export function claimKey(c: { path: string | null; title: string }): string {
	const title = spellOutNegation(c.title);
	const tokens = [...claimTokens(title)].sort();
	const identifiers = [...claimIdentifiers(c.title)].sort();
	const negated = NEGATION.test(title);
	const numbers = [...(title.match(NUMBER) ?? [])].sort();
	const raw =
		tokens.length === 0 && identifiers.length === 0
			? title.replace(/\s+/g, " ").trim()
			: null;
	return sha256(
		JSON.stringify([c.path, tokens, identifiers, negated, numbers, raw]),
	);
}
