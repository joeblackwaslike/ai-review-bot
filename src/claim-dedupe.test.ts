import { describe, expect, it } from "vitest";
import {
	claimIdentifiers,
	claimTokens,
	dedupeClaims,
	isSameClaim,
} from "./claim-dedupe.js";

function claim(
	over: Partial<{
		path: string | null;
		line: number | null;
		title: string;
		severity: string | null;
		body: string;
	}> = {},
) {
	return {
		path: "src/qc-app.ts",
		line: 120,
		title: "a finding",
		severity: "medium" as string | null,
		body: "",
		...over,
	};
}

describe("claimTokens", () => {
	it("drops code spans, stopwords and short words", () => {
		expect(claimTokens("The `body: f.title` is not the description")).toEqual(
			new Set(["description"]),
		);
	});

	it("collapses a verb and its noun form onto one root", () => {
		expect(claimTokens("duplicates")).toEqual(claimTokens("duplicating"));
		expect(claimTokens("duplicated")).toEqual(claimTokens("duplicate"));
	});

	it("collapses inflections so two phrasings of one claim overlap", () => {
		expect(claimTokens("duplicates the title")).toEqual(
			claimTokens("duplicating the titles"),
		);
	});
});

describe("claimIdentifiers", () => {
	it("splits a backticked expression into its identifiers", () => {
		expect(claimIdentifiers("`body: f.title` duplicates it")).toEqual(
			new Set(["body", "title"]),
		);
	});

	it("returns nothing when a title names no code", () => {
		expect(claimIdentifiers("this is badly explained").size).toBe(0);
	});
});

// Every title below is verbatim from a review round on #43 or #45, where each
// group was filed as N separate findings and each group was one claim.
describe("isSameClaim on real duplicate rounds", () => {
	it("matches the eight restatements of the body/title bug", () => {
		const filed = [
			claim({
				line: 116,
				title:
					"Finding body is set to `f.title`, duplicating the title instead of the description",
			}),
			claim({
				line: 122,
				title:
					"`body: f.title` — finding body is the title, not the actual finding description",
			}),
			claim({
				line: 126,
				title: "body field set to f.title — judge receives no full description",
			}),
			claim({
				line: 129,
				title:
					"`body: f.title` — finding body copies the title instead of the full finding text",
			}),
		];
		for (const other of filed.slice(1)) {
			expect(isSameClaim(filed[0], other)).toBe(true);
		}
	});

	it("matches the four restatements of the missing body column", () => {
		const a = claim({
			path: "src/improve/db/repo.ts",
			line: 223,
			title:
				"`listFindingsForPr` selects only `title`; no `body` column is exposed",
		});
		const b = claim({
			path: "src/improve/db/repo.ts",
			line: 234,
			title: "listFindingsForPr does not select a body/description column",
		});
		expect(isSameClaim(a, b)).toBe(true);
	});
});

describe("isSameClaim keeps distinct findings apart", () => {
	// Both name the same function; they are different defects in it.
	it("does not merge two different bugs that share an identifier", () => {
		const a = claim({
			line: 120,
			title: "`loadFindingContext` swallows auth and rate-limit errors",
		});
		const b = claim({
			line: 124,
			title: "`loadFindingContext` is missing the `pr` parameter on its caller",
		});
		expect(isSameClaim(a, b)).toBe(false);
	});

	it("never merges across files, however similar the wording", () => {
		const a = claim({ path: "src/a.ts", title: "`foo` duplicates the title" });
		const b = claim({ path: "src/b.ts", title: "`foo` duplicates the title" });
		expect(isSameClaim(a, b)).toBe(false);
	});

	// Same claim, opposite ends of a large file: two anchors that far apart are
	// far more likely to be two occurrences worth fixing separately.
	it("does not merge the same wording hundreds of lines apart", () => {
		const a = claim({ line: 10, title: "`foo` duplicates the title" });
		const b = claim({ line: 900, title: "`foo` duplicates the title" });
		expect(isSameClaim(a, b)).toBe(false);
	});

	it("treats general findings with no anchor as comparable by title alone", () => {
		const a = claim({
			path: null,
			line: null,
			title: "`foo` duplicates the title text",
		});
		const b = claim({
			path: null,
			line: null,
			title: "`foo` duplicated the titles text",
		});
		expect(isSameClaim(a, b)).toBe(true);
	});
});

describe("dedupeClaims", () => {
	it("keeps one finding per claim and reports how many it collapsed", () => {
		const result = dedupeClaims([
			claim({
				line: 116,
				title:
					"Finding body is set to `f.title`, duplicating the title instead of the description",
			}),
			claim({
				line: 122,
				title:
					"`body: f.title` — finding body is the title, not the actual finding description",
			}),
			claim({
				line: 400,
				title: "Dedup row claimed before any work is done — lost on failure",
			}),
		]);
		expect(result.kept).toHaveLength(2);
		expect(result.collapsed).toBe(1);
	});

	// The reader should get the version that explains the problem, and a cluster
	// containing a high-severity report must not be represented by a low one.
	it("represents a cluster by its most severe, best-explained member", () => {
		const result = dedupeClaims([
			claim({
				line: 116,
				severity: "low",
				title:
					"`body: f.title` duplicates the title instead of passing the finding body",
				body: "short",
			}),
			claim({
				line: 120,
				severity: "high",
				title:
					"body field set to f.title — finding body duplicates the title, no description",
				body: "the long explanation of why this matters",
			}),
		]);
		expect(result.kept).toHaveLength(1);
		expect(result.kept[0].severity).toBe("high");
		expect(result.kept[0].body).toBe(
			"the long explanation of why this matters",
		);
	});

	it("is a no-op on findings that are all distinct", () => {
		const findings = [
			claim({ line: 10, title: "`alpha` is wrong" }),
			claim({ line: 200, title: "`beta` leaks a handle" }),
			claim({ line: 400, title: "`gamma` never awaits" }),
		];
		const result = dedupeClaims(findings);
		expect(result.kept).toEqual(findings);
		expect(result.collapsed).toBe(0);
	});

	it("preserves input order of the survivors", () => {
		const result = dedupeClaims([
			claim({ line: 400, title: "`gamma` never awaits" }),
			claim({ line: 10, title: "`alpha` is wrong and unchecked" }),
			claim({ line: 12, title: "`alpha` is wrong, unchecked and stale" }),
		]);
		expect(result.kept.map((c) => c.line)).toEqual([400, 10]);
	});
});
