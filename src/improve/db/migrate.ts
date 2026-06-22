import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read every generated migration file (in lexical order) and return each
 * individual SQL statement, split on drizzle's `--> statement-breakpoint`
 * marker. Shared by the pg-mem test harness and the real-Postgres integration
 * test so both apply the identical DDL the production migration would. */
export function loadMigrationStatements(): string[] {
	// fileURLToPath (not URL.pathname) so this resolves correctly on Windows,
	// where .pathname yields a leading-slash drive path like `/C:/...`.
	const dir = fileURLToPath(new URL("./migrations", import.meta.url));
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const statements: string[] = [];
	for (const file of files) {
		const raw = readFileSync(join(dir, file), "utf8");
		for (const stmt of raw.split("--> statement-breakpoint")) {
			const trimmed = stmt.trim();
			if (trimmed) statements.push(trimmed);
		}
	}
	return statements;
}
