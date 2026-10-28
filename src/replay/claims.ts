import type { ReplayFixture } from "./types.js";

const MERGE_SEPARATOR = "\n\n---\n\n";
const SEVERITY_BADGE_TEXT = /^P\d$/;

function claimTitle(part: string): string {
	for (const m of part.matchAll(/\*\*(.+?)\*\*/g)) {
		const span = m[1].trim();
		if (span && !SEVERITY_BADGE_TEXT.test(span)) return span;
	}
	return (
		part
			.split("\n")
			.find((l) => l.trim())
			?.trim() ?? ""
	);
}

export function splitInlineClaims(
	body: string,
): { title: string; text: string }[] {
	return body
		.split(MERGE_SEPARATOR)
		.map((text) => text.trim())
		.filter(Boolean)
		.map((text) => ({ title: claimTitle(text), text }));
}

export function fixtureId(
	f: Pick<ReplayFixture, "owner" | "repo" | "pull" | "provider">,
): string {
	return `${f.owner}__${f.repo}__${f.pull}__${f.provider}`;
}
