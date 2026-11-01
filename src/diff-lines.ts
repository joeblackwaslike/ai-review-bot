const HUNK_HEADER = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NUMBER_WIDTH = 5;

interface WalkedLine {
	raw: string;
	right: number | null;
}

function walkPatch(patch: string): WalkedLine[] {
	let next = 0;
	return patch.split("\n").map((raw) => {
		if (raw.startsWith("@@")) {
			const match = HUNK_HEADER.exec(raw);
			if (match) next = Number(match[1]);
			return { raw, right: null };
		}
		if (raw.startsWith("+") || raw.startsWith(" ")) {
			const right = next;
			next += 1;
			return { raw, right };
		}
		return { raw, right: null };
	});
}

/** Right-side (new file) line numbers a unified diff patch can anchor to. */
export function collectRightSideLines(patch: string): Set<number> {
	const lines = new Set<number>();
	for (const { right } of walkPatch(patch)) {
		if (right !== null) lines.add(right);
	}
	return lines;
}

/** Right-side line number to line text, without the diff's `+` or space prefix. */
export function rightSideText(patch: string): Map<number, string> {
	const text = new Map<number, string>();
	for (const { raw, right } of walkPatch(patch)) {
		if (right !== null) text.set(right, raw.slice(1));
	}
	return text;
}

/** Prefix each patch line with its right-side number; deletions, `\` lines
 * and any trailing marker get a blank margin, and `@@` headers are unchanged. */
export function numberPatchLines(patch: string): string {
	return walkPatch(patch)
		.map(({ raw, right }) => {
			if (raw.startsWith("@@")) return raw;
			const margin = right === null ? "" : String(right);
			return `${margin.padStart(NUMBER_WIDTH)} | ${raw}`;
		})
		.join("\n");
}
