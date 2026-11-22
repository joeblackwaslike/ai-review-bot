export interface Stripped {
	text: string;
	hasLiteral: boolean;
}

const WORD = /\w/;

/**
 * Replaces each string literal and number with one space in one pass. A quote kind with no
 * closer fails once and for every later quote, so the scan stays linear.
 */
export function stripLiterals(line: string): Stripped {
	let out = "";
	let hasLiteral = false;
	const dead = new Set<string>();
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if ((ch === '"' || ch === "'" || ch === "`") && !dead.has(ch)) {
			let j = i + 1;
			while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
			if (j < line.length) {
				out += " ";
				hasLiteral = true;
				i = j + 1;
				continue;
			}
			dead.add(ch);
		}
		if (/\d/.test(ch) && !(i > 0 && WORD.test(line[i - 1] as string))) {
			let j = i + 1;
			while (j < line.length && /[\w.]/.test(line[j] as string)) j++;
			out += " ";
			hasLiteral = true;
			i = j;
			continue;
		}
		out += ch;
		i++;
	}
	return { text: out, hasLiteral };
}
