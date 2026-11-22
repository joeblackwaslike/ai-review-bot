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
