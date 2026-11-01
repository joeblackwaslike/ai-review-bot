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

/** Finds the provenance entry for a posted GitHub comment. The title parsed
 * from the rendered body matches almost always; a title containing `**` or a
 * newline does not survive that parse, so on a miss the entries at the same
 * path and line are scanned for one whose stored title appears in the body as
 * `**title**`. */
export function findProvenance<T extends { title: string }>(
	provenance: Map<string, T>,
	comment: { path: string | null; line: number | null; body: string },
	parsedTitle: string,
): T | undefined {
	const direct = provenance.get(
		commentKey({
			path: comment.path,
			line: comment.line,
			title: parsedTitle,
		}),
	);
	if (direct) return direct;
	const prefix = `${comment.path}:${comment.line}:`;
	let best: T | undefined;
	for (const [key, entry] of provenance) {
		if (
			key.startsWith(prefix) &&
			comment.body.includes(`**${entry.title}**`) &&
			(!best || entry.title.length > best.title.length)
		) {
			best = entry;
		}
	}
	return best;
}
