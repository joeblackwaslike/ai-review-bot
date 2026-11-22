/** Prose files: copied wording is not copied logic. */
export const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;

/** Data files: JSON, JSON Lines and JSON5 repeat record shapes, not logic. */
export const DATA_FILE = /\.json(?:l|5)?$/i;

/**
 * Files whose lines are not matched as relocations: lockfiles, minified bundles and snapshots.
 * Regenerating them re-sorts large blocks, which reads as many same-file moves of no review value.
 */
export const UNMATCHED_FILES =
	/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum|[^/]+\.lock)$|\.min\.(?:js|css)$|\.snap$/;

/**
 * Brace and free-form languages where leading and repeated whitespace carries no meaning. Copy
 * claims in any other extension, unknown ones included, compare raw line text.
 */
export const INDENT_FREE_FILE = /\.(?:jsx?|mjs|cjs|tsx?|go|java)$/i;

/**
 * Languages where leading whitespace carries no meaning, so a relocation may differ from its
 * source in indentation. Every other extension, unknown ones included, is compared with its
 * indentation, because Starlark, F#, Scala 3, CoffeeScript, Ruby and shell can all read it.
 */
export const INDENT_COLLAPSIBLE_FILE =
	/\.(?:jsx?|mjs|cjs|tsx?|java|c|h|cpp|hpp|cs|rs|go|kts?|dart|php|s?css|less|json)$/i;

/** The only languages that get copy claims. Every other extension gets none. */
export const COPY_FILE = /\.(?:jsx?|mjs|cjs|tsx?|pyi?|go|java)$/i;

const COPY_BANNED =
	/`|"""|'''|\/\*|\*\/|<<|<!--|-->|\\$|R"|%q|=begin|\{-|--\[\[|\(\*/m;

const quotes = (text: string, quote: string) => text.split(quote).length - 1;

/**
 * Whether a file may take part in a copy claim, as source or target. Coarse on purpose:
 * a miss costs one skipped note, a false claim costs a wrong one. The extension must be in
 * `COPY_FILE`, the whole patch must hold no multi-line construct opener of any language
 * (backtick, triple quote, block comment, heredoc, markup comment, trailing backslash and
 * the rest), and every row must hold an even count of single and of double quotes once
 * escaped quotes are removed. That catches regex literals with quotes, lifetime ticks and
 * apostrophes. An opener outside the patch stays undetected.
 */
export function copyEligible(
	filename: string,
	patch: string | undefined,
): boolean {
	if (!COPY_FILE.test(filename)) return false;
	const text = patch ?? "";
	if (COPY_BANNED.test(text)) return false;
	return text.split("\n").every((row) => {
		if (row.startsWith("@@")) return true;
		const bare = row.slice(1).replace(/\\['"]/g, "");
		return quotes(bare, "'") % 2 === 0 && quotes(bare, '"') % 2 === 0;
	});
}
