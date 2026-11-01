import { createHash } from "node:crypto";
import { rightSideText } from "../diff-lines.js";

const WINDOW_CHARS = 100;
const HASH_CHARS = 16;
const MIN_ANCHOR_CHARS = 12;
const MIN_SUGGESTION_CHARS = 24;
const FP_LINE = /^<!--\s*ai-review:fp=(.+?)\s*-->$/;
const SFP_LINE = /^<!--\s*ai-review:sfp=(.+?)\s*-->$/;

const hash = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, HASH_CHARS);

const stripWhitespace = (text: string) => text.replace(/\s+/g, "");

const MAX_WINDOW_LINES = 20;
const MAX_CACHED_PATCHES = 16;

interface PatchIndex {
	positionOf: Map<number, number>;
	windows: string[];
	occurrence: number[];
}

const indexCache = new Map<string, PatchIndex>();

/** Window text and occurrence index of every right-side line of a patch, built
 * in one pass. The window runs from a line over consecutive lines to about 100
 * characters and never past MAX_WINDOW_LINES, so a long run of blank lines
 * cannot make each lookup walk the whole patch. */
function indexPatch(patch: string): PatchIndex {
	const cached = indexCache.get(patch);
	if (cached) return cached;
	const text = rightSideText(patch);
	const lines = [...text.keys()].sort((a, b) => a - b);
	const stripped = lines.map((line) => stripWhitespace(text.get(line) ?? ""));
	const positionOf = new Map(lines.map((line, i) => [line, i]));
	const windows: string[] = [];
	const occurrence: number[] = [];
	const seen = new Map<string, number>();
	for (let index = 0; index < lines.length; index++) {
		let out = "";
		for (
			let i = index;
			i < lines.length &&
			i - index < MAX_WINDOW_LINES &&
			out.length < WINDOW_CHARS;
			i++
		) {
			if (i > index && lines[i] !== lines[i - 1] + 1) break;
			out += stripped[i];
		}
		windows.push(out);
		if (out.length >= MIN_ANCHOR_CHARS) {
			const key = hash(out);
			occurrence.push(seen.get(key) ?? 0);
			seen.set(key, (seen.get(key) ?? 0) + 1);
		} else {
			occurrence.push(0);
		}
	}
	if (indexCache.size >= MAX_CACHED_PATCHES) indexCache.clear();
	const built = { positionOf, windows, occurrence };
	indexCache.set(patch, built);
	return built;
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
	const { positionOf, windows, occurrence } = indexPatch(input.patch);
	const position = positionOf.get(input.line);
	if (position === undefined) return null;
	const window = windows[position];
	if (window.length < MIN_ANCHOR_CHARS) return null;
	return `${input.category}|${input.path}|${hash(window)}.${occurrence[position]}`;
}

/** Hash of a suggestion's whitespace-stripped replacement code; null under 24
 * characters, where equal code (`return null;`) says nothing about the claim. */
export function suggestionFingerprint(code: string): string | null {
	const stripped = stripWhitespace(code);
	return stripped.length < MIN_SUGGESTION_CHARS ? null : hash(stripped);
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

function splitTrailingMarkers(text: string): { body: string; block: string[] } {
	const lines = text.split("\n");
	const block: string[] = [];
	while (lines.length > 0) {
		const line = lines[lines.length - 1].trim();
		if (line === "") {
			lines.pop();
		} else if (FP_LINE.test(line) || SFP_LINE.test(line)) {
			block.unshift(line);
			lines.pop();
		} else {
			break;
		}
	}
	return { body: lines.join("\n"), block };
}

/** Reads the markers back out of the trailing marker block of a posted
 * comment's text. Only the block at the very end counts, so a marker written
 * into the model's own text cannot stand in for the real one. */
export function readFpMarkers(text: string): { fp?: string; sfp?: string } {
	const { block } = splitTrailingMarkers(text);
	const fp = block
		.map((l) => FP_LINE.exec(l)?.[1])
		.filter(Boolean)
		.at(-1);
	const sfp = block
		.map((l) => SFP_LINE.exec(l)?.[1])
		.filter(Boolean)
		.at(-1);
	return { ...(fp ? { fp } : {}), ...(sfp ? { sfp } : {}) };
}

/** The comment text without its trailing marker block. */
export function stripFpMarkers(text: string): string {
	return splitTrailingMarkers(text).body;
}

/** Removes anything shaped like an fp/sfp marker from model-written text, so it
 * cannot stand in for the markers the bot writes itself. */
export function stripForgedFpMarkers(text: string): string {
	let current = text;
	for (;;) {
		const next = current.replace(/<!--\s*ai-review:s?fp=.*?-->/gs, "");
		if (next === current) return current;
		current = next;
	}
}
