export interface Regions {
	unsafe: Set<number>;
	risky: boolean;
}

const HASH_FILE = /\.(py|pyi|sh|bash|zsh|rb|ya?ml|toml|mk)$/i;
const HEREDOC = /^<<[-~]?(["']?)([A-Za-z_]\w*)\1/;

type Mode = "code" | "block" | "template" | "triple" | "heredoc";

function closeIndex(text: string, from: number, close: string): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text.startsWith(close, i)) return i;
	}
	return -1;
}

/**
 * Scans the head-side rows of one patch, context and added rows in order, for constructs
 * that span lines: block comments, template literals, triple-quoted strings and heredocs.
 * Every line from the opener to the closer is unsafe for a copy claim. A construct still
 * open at the end of the patch marks the whole file risky.
 */
export function scanRegions(
	filename: string,
	patch: string | undefined,
): Regions {
	const out: Regions = { unsafe: new Set(), risky: false };
	const hash = HASH_FILE.test(filename);
	let mode: Mode = "code";
	let closer = "";
	let openedAt = 0;
	let line = 0;
	for (const row of (patch ?? "").split("\n")) {
		const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
		if (header) {
			line = Number(header[1]);
			continue;
		}
		if (row.startsWith("-") || row.startsWith("\\")) continue;
		const text = row.slice(1);
		const n = line++;
		let i = 0;
		const finish = (): void => {
			for (let k = openedAt; k <= n; k++) out.unsafe.add(k);
			mode = "code";
		};
		if (mode === "heredoc") {
			if (text.trim() === closer) finish();
			continue;
		}
		if (mode !== "code") {
			const at = closeIndex(text, 0, closer);
			if (at < 0) continue;
			i = at + closer.length;
			finish();
		}
		while (i < text.length) {
			const ch = text[i] as string;
			const next = text[i + 1];
			const spaced = i === 0 || /\s/.test(text[i - 1] as string);
			if (ch === "/" && next === "*") {
				const at = text.indexOf("*/", i + 2);
				if (at >= 0) i = at + 2;
				else {
					mode = "block";
					closer = "*/";
					openedAt = n;
					break;
				}
			} else if (ch === "/" && next === "/" && spaced && !hash) break;
			else if (ch === "#" && spaced && hash) break;
			else if (ch === "<" && next === "<") {
				const found = HEREDOC.exec(text.slice(i));
				if (found) {
					mode = "heredoc";
					closer = found[2] as string;
					openedAt = n;
					break;
				}
				i += 2;
			} else if (ch === "`") {
				const at = closeIndex(text, i + 1, "`");
				if (at >= 0) i = at + 1;
				else {
					mode = "template";
					closer = "`";
					openedAt = n;
					break;
				}
			} else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
				const quote = text.slice(i, i + 3);
				const at = closeIndex(text, i + 3, quote);
				if (at >= 0) i = at + 3;
				else {
					mode = "triple";
					closer = quote;
					openedAt = n;
					break;
				}
			} else if (ch === '"' || ch === "'") {
				const at = closeIndex(text, i + 1, ch);
				i = at < 0 ? text.length : at + 1;
			} else i++;
		}
	}
	out.risky = mode !== "code";
	return out;
}
