import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../docs/review-ontology/operations",
);
const ENTRY_START = /^## ([A-Z]{3}-\d{2}): (.*)$/;
const KEPT_SECTIONS = new Set([
	"What not to spend review on",
	"Checklist",
	"Red flags",
]);
export const MAX_SELECTED = 4;

function keptText(entryLines: string[]): string {
	const out = [entryLines[0] as string];
	let keep = false;
	for (const line of entryLines.slice(1)) {
		if (line.startsWith("### ")) keep = KEPT_SECTIONS.has(line.slice(4).trim());
		if (keep) out.push(line);
	}
	return out.join("\n").trimEnd();
}

/** Maps each operation id in a markdown file to the kept text of its entry. */
export function parseEntries(markdown: string): Map<string, string> {
	const entries = new Map<string, string>();
	let id: string | null = null;
	let lines: string[] = [];
	const flush = () => {
		if (!id) return;
		if (entries.has(id)) throw new Error(`duplicate operation id ${id}`);
		entries.set(id, keptText(lines));
	};
	for (const line of markdown.split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			const match = ENTRY_START.exec(line);
			id = match ? (match[1] as string) : null;
			lines = [line];
		} else if (id) {
			lines.push(line);
		}
	}
	flush();
	return entries;
}

/** Loads every operation entry from the operations directory, skipping the template. */
export function loadEntries(dir: string = DEFAULT_DIR): Map<string, string> {
	const entries = new Map<string, string>();
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".md") || file === "_template.md") continue;
		for (const [id, text] of parseEntries(
			readFileSync(join(dir, file), "utf8"),
		)) {
			if (entries.has(id))
				throw new Error(`duplicate operation id ${id} in ${file}`);
			if (text.split("\n").length < 2)
				throw new Error(`operation ${id} in ${file} has no kept section`);
			entries.set(id, text);
		}
	}
	return entries;
}

/** Hashes the contents of the sorted entry files, so editing a runbook makes stored cells stale. */
export function entriesHash(dir: string = DEFAULT_DIR): string {
	const hash = createHash("sha256");
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".md") || file === "_template.md") continue;
		hash.update(readFileSync(join(dir, file), "utf8"));
	}
	return hash.digest("hex");
}

/** Joins the kept text of known ids in order, deduplicated, capped at four. */
export function selectEntries(
	entries: Map<string, string>,
	ids: string[],
): string {
	const picked = [...new Set(ids)]
		.filter((id) => entries.has(id))
		.slice(0, MAX_SELECTED);
	return picked.map((id) => entries.get(id)).join("\n\n");
}

/** Lists the id and name of every entry for the triage prompt. */
export function entryHeadings(
	entries: Map<string, string>,
): { id: string; name: string }[] {
	return [...entries].map(([id, text]) => ({
		id,
		name: ENTRY_START.exec(text.split("\n")[0] as string)?.[2] ?? "",
	}));
}
