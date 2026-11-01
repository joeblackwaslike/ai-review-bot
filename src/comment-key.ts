/** Identity of one inline comment. Two distinct claims can share a path and
 * line, so the title is part of the key; it is lowercased and trimmed so a
 * model's casing drift does not split one claim into two. */
export function commentKey(c: {
	path: string | null;
	line: number | null;
	title: string;
}): string {
	return `${c.path}:${c.line}:${c.title.toLowerCase().trim()}`;
}
