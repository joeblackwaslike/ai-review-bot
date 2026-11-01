import { createHash } from "node:crypto";
import { rightSideText } from "../diff-lines.js";

const WINDOW_CHARS = 100;
const HASH_CHARS = 16;
const FP_MARKER = /<!--\s*ai-review:fp=(.+?)\s*-->/;
const SFP_MARKER = /<!--\s*ai-review:sfp=(.+?)\s*-->/;

const hash = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, HASH_CHARS);

const stripWhitespace = (text: string) => text.replace(/\s+/g, "");

function windowAt(
	text: Map<number, string>,
	lines: number[],
	index: number,
): string {
	let out = "";
	for (let i = index; i < lines.length && out.length < WINDOW_CHARS; i++) {
		if (i > index && lines[i] !== lines[i - 1] + 1) break;
		out += stripWhitespace(text.get(lines[i]) ?? "");
	}
	return out;
}

/** `category|path|hash.n`: the whitespace-stripped right-side code from the
 * anchor line to about 100 characters, hashed, plus the zero-based index of
 * this window among identical windows in the patch. Null when the line is not
 * on the right side of the patch. */
export function anchorFingerprint(input: {
	category: string;
	path: string;
	line: number;
	patch: string;
}): string | null {
	const text = rightSideText(input.patch);
	if (!text.has(input.line)) return null;
	const lines = [...text.keys()].sort((a, b) => a - b);
	const target = hash(windowAt(text, lines, lines.indexOf(input.line)));
	let n = 0;
	for (let i = 0; i < lines.length && lines[i] < input.line; i++) {
		if (hash(windowAt(text, lines, i)) === target) n += 1;
	}
	return `${input.category}|${input.path}|${target}.${n}`;
}

/** Hash of a suggestion's whitespace-stripped replacement code. */
export function suggestionFingerprint(code: string): string {
	return hash(stripWhitespace(code));
}

/** HTML-comment marker lines for a posted inline comment; empty when neither is set. */
export function formatFpMarkers(markers: {
	fp?: string;
	sfp?: string;
}): string {
	return [
		markers.fp ? `<!-- ai-review:fp=${markers.fp} -->` : "",
		markers.sfp ? `<!-- ai-review:sfp=${markers.sfp} -->` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Reads the markers back out of a posted comment's text. */
export function readFpMarkers(text: string): { fp?: string; sfp?: string } {
	const fp = FP_MARKER.exec(text)?.[1];
	const sfp = SFP_MARKER.exec(text)?.[1];
	return { ...(fp ? { fp } : {}), ...(sfp ? { sfp } : {}) };
}
