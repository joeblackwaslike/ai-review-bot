import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./testing.js";

describe("createTestDb", () => {
	it("creates an in-memory db with the corpus tables", async () => {
		const db = await createTestDb();
		const rows = await db.execute(
			sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
		);
		const names = rows.rows.map((r) => r.table_name);
		expect(names).toContain("raw_feedback");
		expect(names).toContain("finding_catalog");
		expect(names).toContain("proposals");
	});
});
