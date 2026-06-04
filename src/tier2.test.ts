import { describe, expect, it } from "vitest";
import type { Tier2Context } from "./tier2.js";
import { detectTier2Skills } from "./tier2.js";

const base: Tier2Context = {
	filePaths: [],
	additions: 10,
	deletions: 5,
	title: "Update some code",
	body: null,
	labels: [],
	patchContent: "",
};

describe("detectTier2Skills", () => {
	it("returns empty array for a plain small PR with no triggers", () => {
		expect(detectTier2Skills(base)).toEqual([]);
	});

	// ── Type Design Analyzer ─────────────────────────────────────────────────

	it("activates type-design-analyzer for TypeScript files with interface changes", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/models.ts"],
			patchContent: "+interface User { id: string; }",
		});
		expect(matches.map((m) => m.skillPath)).toContain(
			"type-design-analyzer.md",
		);
	});

	it("does not activate type-design-analyzer for TypeScript files with no type changes", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/utils.ts"],
			patchContent: "+const x = 1;",
		});
		expect(matches.map((m) => m.skillPath)).not.toContain(
			"type-design-analyzer.md",
		);
	});

	it("does not activate type-design-analyzer for non-typed files", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/utils.rb"],
			patchContent: "+class User; end",
		});
		expect(matches.map((m) => m.skillPath)).not.toContain(
			"type-design-analyzer.md",
		);
	});

	// ── Comment Analyzer ─────────────────────────────────────────────────────

	it("activates comment-analyzer when documentation files are changed", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["docs/api.md", "src/utils.ts"],
		});
		expect(matches.map((m) => m.skillPath)).toContain("comment-analyzer.md");
	});

	it("activates comment-analyzer when many comment lines are added", () => {
		const manyComments = Array.from(
			{ length: 6 },
			(_, i) => `+// line ${i}`,
		).join("\n");
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/service.ts"],
			patchContent: manyComments,
		});
		expect(matches.map((m) => m.skillPath)).toContain("comment-analyzer.md");
	});

	// ── Security Auditor ─────────────────────────────────────────────────────

	it("activates security-auditor for auth path changes", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/auth/login.ts"],
		});
		expect(matches.map((m) => m.skillPath)).toContain("security-auditor.md");
	});

	it("activates security-auditor for payment path changes", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/billing/stripe.ts"],
		});
		expect(matches.map((m) => m.skillPath)).toContain("security-auditor.md");
	});

	it("activates security-auditor when title and body both mention auth and security", () => {
		const matches = detectTier2Skills({
			...base,
			title: "Add auth middleware",
			body: "This implements security improvements to the token system",
		});
		expect(matches.map((m) => m.skillPath)).toContain("security-auditor.md");
	});

	it("activates security-auditor for crypto-adjacent patch content", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/utils.ts"],
			patchContent: "+const hash = bcrypt.hash(password, 10);",
		});
		expect(matches.map((m) => m.skillPath)).toContain("security-auditor.md");
	});

	// ── Architect Review ─────────────────────────────────────────────────────

	it("activates architect-review for large PRs with many files", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`),
			additions: 250,
			deletions: 100,
		});
		expect(matches.map((m) => m.skillPath)).toContain("architect-review.md");
	});

	it("activates architect-review when architecture label is present", () => {
		const matches = detectTier2Skills({ ...base, labels: ["architecture"] });
		expect(matches.map((m) => m.skillPath)).toContain("architect-review.md");
	});

	it("activates architect-review when 3+ architectural boundary files change", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: [
				"src/api/routes.ts",
				"src/services/user.ts",
				"database/migrations/001.sql",
			],
		});
		expect(matches.map((m) => m.skillPath)).toContain("architect-review.md");
	});

	it("does not activate architect-review for a small standard PR", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/utils.ts"],
			additions: 20,
			deletions: 5,
		});
		expect(matches.map((m) => m.skillPath)).not.toContain(
			"architect-review.md",
		);
	});

	// ── Multiple activations ─────────────────────────────────────────────────

	it("can activate multiple Tier 2 skills at once", () => {
		const matches = detectTier2Skills({
			...base,
			// auth → security-auditor; api/ + migration + service/ → architect-review; .ts + interface → type-design
			filePaths: [
				"src/auth/token.ts",
				"database/migrations/001.sql",
				"src/api/routes.ts",
				"src/services/user.ts",
			],
			additions: 400,
			deletions: 50,
			patchContent: "+interface TokenPayload { sub: string; }",
			title: "Refactor auth and add new schema migration",
			body: "Security-sensitive changes to token handling",
		});
		const skills = matches.map((m) => m.skillPath);
		expect(skills).toContain("type-design-analyzer.md");
		expect(skills).toContain("security-auditor.md");
		expect(skills).toContain("architect-review.md");
	});

	// ── Reason strings ───────────────────────────────────────────────────────

	it("includes a non-empty reason string for each activated skill", () => {
		const matches = detectTier2Skills({
			...base,
			filePaths: ["src/auth/login.ts"],
		});
		for (const match of matches) {
			expect(match.reason.length).toBeGreaterThan(0);
		}
	});
});
