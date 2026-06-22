# Improvement Loop — Phase 1: Corpus Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Neon Postgres corpus (Drizzle schema + migration + pooled client + typed data-access repo) that every later phase reads and writes.

**Architecture:** A new `src/improve/db/` package. `schema.ts` is the single source of truth for all corpus tables (defined in full now so later phases only consume it). `client.ts` exposes a module-level pooled `pg.Pool` + Drizzle singleton (drop-on-error, mirroring `kvSingleton` in `github-app.ts`). `repo.ts` holds typed, idempotent data-access functions; the bulk of logic is pure and unit-tested against **pg-mem** using the same `node-postgres` driver as production.

**Tech Stack:** `drizzle-orm` (`drizzle-orm/node-postgres`), `pg` (node-postgres) over Neon's **pooled** connection string, `drizzle-kit` (migrations), `pg-mem` (in-memory Postgres for tests), Vitest, Zod v4. Biome enforces **tab** indent + **double** quotes — run `npm run lint -- --write` before each commit. All imports use `.js` extensions; **named exports only**; **no banner comments**.

**Spec:** `docs/superpowers/specs/2026-06-21-feedback-improvement-loop-design.md` (§ Neon schema, § Module decomposition, § Risks).

**Decision (resolves spec Open Question #2):** Use `pg` (node-postgres) + `drizzle-orm/node-postgres`, NOT `@neondatabase/serverless`. These functions run on the Vercel **Node** runtime (`@vercel/node`), not edge; node-postgres + Neon's pooler endpoint is the supported pattern there, and it gives **type parity with pg-mem** so repo functions are tested against the real driver type.

---

### Task 1: Add dependencies, Drizzle config, and npm scripts

**Files:**
- Modify: `package.json` (dependencies, devDependencies, scripts)
- Create: `drizzle.config.ts`
- Modify: `.env.example` (add `DATABASE_URL`)

- [ ] **Step 1: Install runtime + dev dependencies**

Run:
```bash
npm install drizzle-orm pg
npm install -D drizzle-kit pg-mem @types/pg
```
Expected: `package.json` gains `drizzle-orm`, `pg` under `dependencies` and `drizzle-kit`, `pg-mem`, `@types/pg` under `devDependencies`; `npm install` exits 0.

- [ ] **Step 2: Add db scripts to `package.json`**

In the `"scripts"` block, add:
```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate"
```
(Place them after `"test"`. Keep tab indentation.)

- [ ] **Step 3: Create `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/improve/db/schema.ts",
	out: "./src/improve/db/migrations",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
});
```

- [ ] **Step 4: Document `DATABASE_URL` in `.env.example`**

Append:
```bash
# Neon Postgres (improvement-loop corpus). Use the POOLED connection string.
# Reachable from the Vercel cron, the ai-review CLI, and the dashboard.
DATABASE_URL=
```

- [ ] **Step 5: Verify typecheck + lint pass with no schema yet**

Run: `npm run typecheck`
Expected: PASS (drizzle.config.ts compiles; schema file referenced only by drizzle-kit at runtime).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json drizzle.config.ts .env.example
git commit -m "build(improve): add drizzle + pg + pg-mem deps and db config"
```

---

### Task 2: Define the full corpus schema

**Files:**
- Create: `src/improve/db/schema.ts`
- Test: `src/improve/db/schema.test.ts`

This file is the single source of truth for all corpus tables. Define every table now (later phases only consume it). `titleHash`/`dedup_key` values are computed by `repo.ts`, not the DB.

- [ ] **Step 1: Write the schema**

```ts
import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const provider = pgEnum("provider", ["anthropic", "openai"]);
export const feedbackSource = pgEnum("feedback_source", [
	"inline_reaction",
	"review_reaction",
	"inline_reply",
	"pr_comment",
]);
export const feedbackIntent = pgEnum("feedback_intent", [
	"downvote",
	"upvote",
	"bug_report",
	"noise",
]);
export const trendKind = pgEnum("trend_kind", [
	"skill_downvote_ratio",
	"skill_positive_signal",
	"repeated_fp_signature",
	"qc_disagreement",
	"downvote_spike",
]);
export const qcTrigger = pgEnum("qc_trigger", ["command", "sample"]);
export const proposalKind = pgEnum("proposal_kind", ["issue", "pr"]);
export const proposalStatus = pgEnum("proposal_status", [
	"open",
	"spec_ready",
	"approved",
	"pr_open",
	"closed_merged",
	"closed_rejected",
]);

export const findingCatalog = pgTable(
	"finding_catalog",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		provider: provider("provider").notNull(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		commentId: bigint("comment_id", { mode: "number" }),
		reviewId: bigint("review_id", { mode: "number" }),
		path: text("path"),
		line: integer("line"),
		skills: text("skills").array().notNull(),
		title: text("title").notNull(),
		severity: text("severity"),
		headSha: text("head_sha").notNull(),
		postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
		naturalKey: text("natural_key").notNull(),
	},
	(t) => [
		uniqueIndex("finding_catalog_natural_key_uq").on(t.naturalKey),
		index("finding_catalog_pr_idx").on(t.provider, t.owner, t.repo, t.pr),
	],
);

export const rawFeedback = pgTable(
	"raw_feedback",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		source: feedbackSource("source").notNull(),
		provider: provider("provider").notNull(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		commentId: bigint("comment_id", { mode: "number" }),
		reviewId: bigint("review_id", { mode: "number" }),
		inReplyToId: bigint("in_reply_to_id", { mode: "number" }),
		path: text("path"),
		line: integer("line"),
		skills: text("skills").array(),
		title: text("title"),
		verdict: text("verdict"),
		actor: text("actor").notNull(),
		body: text("body"),
		eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
		capturedAt: timestamp("captured_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [
		uniqueIndex("raw_feedback_dedup_key_uq").on(t.dedupKey),
		index("raw_feedback_pr_idx").on(t.provider, t.owner, t.repo, t.pr),
		index("raw_feedback_source_idx").on(t.source),
		index("raw_feedback_captured_at_idx").on(t.capturedAt),
	],
);

export const classifiedFeedback = pgTable(
	"classified_feedback",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		rawFeedbackId: bigint("raw_feedback_id", { mode: "number" })
			.notNull()
			.references(() => rawFeedback.id),
		intent: feedbackIntent("intent").notNull(),
		confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
		isBotRelated: boolean("is_bot_related").notNull(),
		matchedFindingId: bigint("matched_finding_id", { mode: "number" }).references(
			() => findingCatalog.id,
		),
		fpSignature: text("fp_signature"),
		model: text("model").notNull(),
		classifiedAt: timestamp("classified_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		uniqueIndex("classified_feedback_raw_uq").on(t.rawFeedbackId),
		index("classified_feedback_intent_idx").on(t.intent),
		index("classified_feedback_fp_sig_idx").on(t.fpSignature),
	],
);

export const qcScores = pgTable(
	"qc_scores",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		findingId: bigint("finding_id", { mode: "number" })
			.notNull()
			.references(() => findingCatalog.id),
		provider: provider("provider").notNull(),
		trigger: qcTrigger("trigger").notNull(),
		isFalsePositive: boolean("is_false_positive").notNull(),
		isUseful: boolean("is_useful").notNull(),
		severityCorrect: boolean("severity_correct").notNull(),
		suggestedSeverity: text("suggested_severity"),
		rationale: text("rationale").notNull(),
		prCommentId: bigint("pr_comment_id", { mode: "number" }),
		model: text("model").notNull(),
		judgedAt: timestamp("judged_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("qc_scores_dedup_key_uq").on(t.dedupKey)],
);

export const qcRuns = pgTable(
	"qc_runs",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		trigger: qcTrigger("trigger").notNull(),
		prCommentId: bigint("pr_comment_id", { mode: "number" }),
		findingsJudged: integer("findings_judged").notNull(),
		falsePositives: integer("false_positives").notNull(),
		ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("qc_runs_dedup_key_uq").on(t.dedupKey)],
);

export const trends = pgTable(
	"trends",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		kind: trendKind("kind").notNull(),
		signature: text("signature").notNull(),
		windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
		windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
		metricValue: numeric("metric_value").notNull(),
		sampleSize: integer("sample_size").notNull(),
		detail: jsonb("detail").notNull(),
		detectedAt: timestamp("detected_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("trends_dedup_key_uq").on(t.dedupKey)],
);

export const proposals = pgTable(
	"proposals",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		trendId: bigint("trend_id", { mode: "number" }).references(() => trends.id),
		kind: proposalKind("kind").notNull(),
		status: proposalStatus("status").notNull().default("open"),
		signature: text("signature").notNull(),
		githubNumber: integer("github_number"),
		githubUrl: text("github_url"),
		targetFile: text("target_file"),
		openedAt: timestamp("opened_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dedupKey: text("dedup_key").notNull(),
	},
	(t) => [uniqueIndex("proposals_dedup_key_uq").on(t.dedupKey)],
);
```

- [ ] **Step 2: Write a schema sanity test**

`src/improve/db/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
	classifiedFeedback,
	feedbackIntent,
	findingCatalog,
	proposals,
	qcRuns,
	qcScores,
	rawFeedback,
	trends,
} from "./schema.js";

describe("corpus schema", () => {
	it("exposes all corpus tables", () => {
		for (const t of [
			rawFeedback,
			classifiedFeedback,
			findingCatalog,
			qcScores,
			qcRuns,
			trends,
			proposals,
		]) {
			expect(t).toBeDefined();
		}
	});

	it("declares the feedback_intent enum values", () => {
		expect(feedbackIntent.enumValues).toEqual([
			"downvote",
			"upvote",
			"bug_report",
			"noise",
		]);
	});
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/improve/db/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Lint + typecheck**

Run: `npm run lint -- --write && npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/improve/db/schema.ts src/improve/db/schema.test.ts
git commit -m "feat(improve): corpus Drizzle schema (all tables + enums)"
```

---

### Task 3: Generate the initial migration

**Files:**
- Create: `src/improve/db/migrations/*` (generated by drizzle-kit)

- [ ] **Step 1: Generate the migration SQL**

Run: `npm run db:generate`
Expected: a `src/improve/db/migrations/0000_*.sql` file + `meta/` snapshot are created; output reports the new tables/enums. (No `DATABASE_URL` needed for `generate`.)

- [ ] **Step 2: Sanity-check the generated SQL**

Run: `grep -c "CREATE TABLE" src/improve/db/migrations/0000_*.sql`
Expected: `7` (the seven corpus tables).

- [ ] **Step 3: Commit**

```bash
git add src/improve/db/migrations
git commit -m "feat(improve): initial corpus migration (drizzle-kit generate)"
```

---

### Task 4: Pooled Drizzle client singleton

**Files:**
- Create: `src/improve/db/client.ts`
- Test: `src/improve/db/client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/improve/db/client.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbSingleton } from "./client.js";

describe("getDb", () => {
	afterEach(() => {
		resetDbSingleton();
		vi.unstubAllEnvs();
	});

	it("throws a clear error when DATABASE_URL is unset", () => {
		vi.stubEnv("DATABASE_URL", "");
		expect(() => getDb()).toThrow(/DATABASE_URL/);
	});

	it("returns the same instance on repeated calls", () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pw@localhost:5432/db");
		const a = getDb();
		const b = getDb();
		expect(a).toBe(b);
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/improve/db/client.test.ts`
Expected: FAIL ("Cannot find module './client.js'").

- [ ] **Step 3: Implement the client**

`src/improve/db/client.ts`:
```ts
import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let db: Db | null = null;

/** Lazily build a pooled Drizzle client over the Neon POOLED connection string.
 * Singleton so concurrent cron/webhook/dashboard invocations on a warm instance
 * share one pool (mirrors the kvSingleton pattern). */
export function getDb(): Db {
	if (db) return db;
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error("DATABASE_URL is required for the improvement-loop corpus");
	}
	pool = new Pool({ connectionString: url });
	db = drizzle(pool, { schema });
	return db;
}

/** Drop the cached client (call after a transient connection error so the next
 * call rebuilds it, and to isolate tests). */
export function resetDbSingleton(): void {
	pool?.end().catch(() => {});
	pool = null;
	db = null;
}
```
Note: constructing `new Pool({ connectionString })` does NOT open a socket until the first query, so the singleton test stays offline.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/improve/db/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint -- --write && npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/improve/db/client.ts src/improve/db/client.test.ts
git commit -m "feat(improve): pooled Drizzle client singleton (getDb/resetDbSingleton)"
```

---

### Task 5: pg-mem test harness

**Files:**
- Create: `src/improve/db/testing.ts`
- Test: `src/improve/db/testing.test.ts`

This builds an in-memory Drizzle DB (same node-postgres driver) with the schema applied, so repo tests run with zero external services.

- [ ] **Step 1: Write the failing test**

`src/improve/db/testing.test.ts`:
```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/improve/db/testing.test.ts`
Expected: FAIL ("Cannot find module './testing.js'").

- [ ] **Step 3: Implement the harness**

`src/improve/db/testing.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { newDb } from "pg-mem";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

/** Build an isolated in-memory Postgres (pg-mem) with the full corpus schema
 * applied, wrapped in the same node-postgres Drizzle driver used in production.
 * Each call returns a fresh, independent database. */
export async function createTestDb(): Promise<Db> {
	const mem = newDb();
	const adapter = mem.adapters.createPg();
	const pool = new adapter.Pool();
	const db = drizzle(pool, { schema }) as unknown as Db;
	await applySchema(db);
	return db;
}

async function applySchema(db: Db): Promise<void> {
	const { readFileSync, readdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const dir = new URL("./migrations", import.meta.url).pathname;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const file of files) {
		const raw = readFileSync(join(dir, file), "utf8");
		// drizzle migration files separate statements with a breakpoint marker.
		for (const stmt of raw.split("--> statement-breakpoint")) {
			const trimmed = stmt.trim();
			if (trimmed) await db.execute(sqlRaw(trimmed));
		}
	}
}

import { sql } from "drizzle-orm";
function sqlRaw(text: string) {
	return sql.raw(text);
}
```
Note: keep the `import { sql }` at the top with the others when Biome's organize-imports runs; the inline placement above is illustrative. If pg-mem rejects a generated statement (e.g. an unsupported `CREATE TYPE` form), adjust `applySchema` to translate it, or fall back to the opt-in Neon integration test (spec Open Question #4) — but verify the common-path tables apply first.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/improve/db/testing.test.ts`
Expected: PASS. If pg-mem errors on the enum/`CREATE TYPE` statements, register them via `mem.public.registerEquivalentType` or strip `CREATE TYPE`/cast enum columns to `text` in the test harness only, then re-run.

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint -- --write && npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/improve/db/testing.ts src/improve/db/testing.test.ts
git commit -m "test(improve): pg-mem in-memory corpus test harness"
```

---

### Task 6: Foundational repo functions (idempotent writes)

**Files:**
- Create: `src/improve/db/repo.ts`
- Test: `src/improve/db/repo.test.ts`

Implement the two cross-cutting idempotent writers every later phase depends on: `insertRawFeedback` (ON CONFLICT dedup_key DO NOTHING) and `upsertFinding` (ON CONFLICT natural_key DO UPDATE). Later phases extend `repo.ts` with their own queries.

- [ ] **Step 1: Write the failing test**

`src/improve/db/repo.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "./testing.js";
import { insertRawFeedback, upsertFinding } from "./repo.js";

const baseRaw = {
	source: "inline_reaction" as const,
	provider: "anthropic" as const,
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pr: 7,
	commentId: 111,
	reviewId: null,
	inReplyToId: null,
	path: "src/a.ts",
	line: 4,
	skills: ["code-reviewer.md"],
	title: "Null deref",
	verdict: "down",
	actor: "octocat",
	body: null,
	eventAt: new Date("2026-06-21T00:00:00Z"),
	dedupKey: "react:inline_reaction:111:octocat:down",
};

const baseFinding = {
	provider: "anthropic" as const,
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pr: 7,
	commentId: 111,
	reviewId: null,
	path: "src/a.ts",
	line: 4,
	skills: ["code-reviewer.md"],
	title: "Null deref",
	severity: "high",
	headSha: "abc123",
	postedAt: new Date("2026-06-21T00:00:00Z"),
	naturalKey: "anthropic:joeblackwaslike/ai-review-bot#7:src/a.ts:4:deadbeef",
};

describe("insertRawFeedback", () => {
	it("inserts a row", async () => {
		const db = await createTestDb();
		const inserted = await insertRawFeedback(db, baseRaw);
		expect(inserted).toBe(1);
	});

	it("is idempotent on dedup_key (ON CONFLICT DO NOTHING)", async () => {
		const db = await createTestDb();
		await insertRawFeedback(db, baseRaw);
		const second = await insertRawFeedback(db, baseRaw);
		expect(second).toBe(0);
	});
});

describe("upsertFinding", () => {
	it("inserts then updates the same natural_key without duplicating", async () => {
		const db = await createTestDb();
		const id1 = await upsertFinding(db, baseFinding);
		const id2 = await upsertFinding(db, { ...baseFinding, severity: "medium" });
		expect(id2).toBe(id1);
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/improve/db/repo.test.ts`
Expected: FAIL ("Cannot find module './repo.js'").

- [ ] **Step 3: Implement the repo functions**

`src/improve/db/repo.ts`:
```ts
import type { Db } from "./client.js";
import { findingCatalog, rawFeedback } from "./schema.js";

export type RawFeedbackInsert = typeof rawFeedback.$inferInsert;
export type FindingInsert = typeof findingCatalog.$inferInsert;

/** Insert a raw feedback row; a duplicate dedup_key is a no-op.
 * Returns the number of rows actually inserted (1 on insert, 0 on conflict). */
export async function insertRawFeedback(
	db: Db,
	row: RawFeedbackInsert,
): Promise<number> {
	const inserted = await db
		.insert(rawFeedback)
		.values(row)
		.onConflictDoNothing({ target: rawFeedback.dedupKey })
		.returning({ id: rawFeedback.id });
	return inserted.length;
}

/** Upsert a finding by its natural_key, returning the row id (stable across
 * updates). Later phases join feedback/QC against finding_catalog.id. */
export async function upsertFinding(
	db: Db,
	row: FindingInsert,
): Promise<number> {
	const result = await db
		.insert(findingCatalog)
		.values(row)
		.onConflictDoUpdate({
			target: findingCatalog.naturalKey,
			set: {
				severity: row.severity,
				headSha: row.headSha,
				skills: row.skills,
				title: row.title,
			},
		})
		.returning({ id: findingCatalog.id });
	return result[0].id;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/improve/db/repo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint -- --write && npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm run test`
Expected: all existing tests + the new ones PASS (277 prior + new).

- [ ] **Step 7: Commit**

```bash
git add src/improve/db/repo.ts src/improve/db/repo.test.ts
git commit -m "feat(improve): idempotent repo writers (insertRawFeedback, upsertFinding)"
```

---

## Self-Review

**Spec coverage (Phase 1 slice of § Neon schema + § Module decomposition):**
- All 7 tables + 7 enums → Task 2 (full `schema.ts`). ✓
- Migration → Task 3. ✓
- `db/client.ts` pooled singleton (drop-on-error) → Task 4 (`getDb`/`resetDbSingleton`). ✓
- `db/repo.ts` typed idempotent data access → Task 6 (foundational writers; later phases extend). ✓
- pg-mem test layer (spec § Testing) → Task 5. ✓
- Neon driver decision (Open Question #2) → resolved in header (node-postgres + pooler). ✓
- Open Question #4 (pg-mem fidelity for enums/`unnest`) → flagged inline in Task 5 Step 4 with a fallback. ✓

Out of Phase 1 scope (later phases): drain/capture (P2), classify/match (P3), trends/anomaly (P4), QC (P5), issues (P6), CLI/cron (P7), dashboard (P8), runbooks (P9). The remaining `repo.ts` query functions are added by the phase that first needs them — intentional, not a gap.

**Placeholder scan:** No TBD/TODO; every code step shows full code. The only conditional is Task 5 Step 4's pg-mem enum fallback, which gives concrete remediation (`registerEquivalentType` / cast to text) rather than a vague "handle errors."

**Type consistency:** `Db` (from `client.ts`) is the single db type used by `testing.ts` and `repo.ts`. `RawFeedbackInsert`/`FindingInsert` derive from the schema via `$inferInsert`, so the test fixtures and function params stay in lockstep with `schema.ts`. `getDb`/`resetDbSingleton` names match between `client.ts` and its test.
