const MARKER_LINE = /^<!--\s*ai-review:([\w-]+)=([^\s>]+)\s*-->\s*$/;
const MODEL_FOOTER = "*Model:";

/**
 * Reads the `ai-review:key=value` markers from the block that
 * `formatReviewBody` writes just above the `---` footer. Only lines that start
 * at column 0 and sit in one contiguous run count, so a quoted earlier review
 * or marker text inside the summary cannot be mistaken for the real block. A
 * key that appears twice is dropped. Returns null when the body has no such
 * block (a legacy body).
 */
export function readMetadataBlock(body: string): Map<string, string> | null {
	const lines = body.split("\n");
	let end = lines.length;
	for (let i = lines.length - 2; i >= 0; i--) {
		if (lines[i]?.trim() === "---" && lines[i + 1]?.startsWith(MODEL_FOOTER)) {
			end = i;
			break;
		}
	}
	while (end > 0 && lines[end - 1]?.trim() === "") end--;
	let start = end;
	while (start > 0 && MARKER_LINE.test(lines[start - 1] ?? "")) start--;
	if (start === end) return null;

	const values = new Map<string, string>();
	const duplicated = new Set<string>();
	for (const line of lines.slice(start, end)) {
		const m = MARKER_LINE.exec(line);
		if (!m?.[1] || m[2] === undefined) continue;
		if (values.has(m[1])) duplicated.add(m[1]);
		values.set(m[1], m[2]);
	}
	for (const key of duplicated) values.delete(key);
	return values;
}

/**
 * Whether a review body is this bot's own review. Both production bots can
 * post under the same `### <prefix>` heading, so the heading must sit on its
 * own unquoted line and the `provider` marker must be absent (a legacy body)
 * or equal `o.provider`.
 */
export function isOwnReview(
	body: string | null | undefined,
	o: { commentPrefix: string; provider: string },
): boolean {
	if (!body) return false;
	const heading = `### ${o.commentPrefix}`;
	if (!body.split("\n").some((line) => line.trimEnd() === heading))
		return false;
	const provider = readMetadataValue(body, "provider");
	return provider === undefined || provider === o.provider;
}

/** One marker value: from the block, or by whole-body search for a legacy body. */
export function readMetadataValue(
	body: string,
	key: string,
): string | undefined {
	const block = readMetadataBlock(body);
	if (block) return block.get(key);
	return body.match(
		new RegExp(`<!--\\s*ai-review:${key}=([^\\s>]+)\\s*-->`),
	)?.[1];
}
