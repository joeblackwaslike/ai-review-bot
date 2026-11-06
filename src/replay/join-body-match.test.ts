import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countJoined } from "./metrics.js";
import type { PostedClaim, ReplayFixture } from "./types.js";

const fixture = JSON.parse(
	readFileSync(
		new URL(
			"./fixtures/joeblackwaslike__ai-listings__50__anthropic.json",
			import.meta.url,
		),
		"utf8",
	),
) as ReplayFixture;
const claims = fixture.rounds.flatMap((r) => r.claims);
const P = "src/lib/pipeline/step3-pricing-research.ts";
const LOG_MISS =
	"Log condition misses the case where the first parsed object has zero entries due to all entries being invalid";
const LOG_SILENCED =
	"Log condition fix silences the error for an all-invalid-entry response — a meaningful signal is lost";
const CATCH =
	"Silent failure in scoreCompRelevance catch block swallows all LLM/network errors without logging";

type Row = [
	verdict: "same" | "different",
	path: string | null,
	line: number | null,
	title: string,
	claimTitle: string,
];

const rows: Row[] = [
	[
		"same",
		P,
		502,
		"Prose with valid-JSON braces can shadow the real payload",
		LOG_MISS,
	],
	[
		"same",
		P,
		502,
		"Valid-JSON prose object stops the scan before the real payload",
		LOG_MISS,
	],
	[
		"same",
		P,
		502,
		"Valid-JSON prose braces can mask the real payload",
		LOG_MISS,
	],
	[
		"different",
		P,
		722,
		"Batch failure also silently inflates sold-comp median input",
		LOG_MISS,
	],
	[
		"different",
		null,
		null,
		"No tests for scoreCompRelevance per-batch failure isolation or null-score fail-closed/fail-open behavior",
		CATCH,
	],
	[
		"different",
		P,
		446,
		"Brace counting ignores braces inside JSON strings",
		"NaN map key from non-numeric LLM response keys",
	],
	[
		"different",
		null,
		null,
		"Failed-batch null scores may be mishandled by code outside the diff",
		CATCH,
	],
	[
		"different",
		null,
		null,
		"Failed-batch null scores may not be handled by other consumers of CompRelevance",
		CATCH,
	],
	[
		"different",
		P,
		440,
		"Multiple top-level objects silently drop data without a log",
		"Regex greedily merges multiple JSON objects in one response",
	],
	[
		"different",
		P,
		451,
		"No test for escaped quote inside string value",
		"NaN map key from non-numeric LLM response keys",
	],
	["different", P, 492, "Empty-object case no longer logged", LOG_SILENCED],
	[
		"different",
		P,
		492,
		"Silent empty result may hide malformed LLM output",
		LOG_SILENCED,
	],
	[
		"different",
		P,
		488,
		"Parse-failure candidates are skipped with no logging",
		LOG_SILENCED,
	],
	[
		"different",
		P,
		504,
		"No diagnostic when every candidate fails JSON.parse",
		LOG_MISS,
	],
	[
		"different",
		null,
		null,
		"Missing tests for new multi-candidate scanning branches",
		CATCH,
	],
];

describe("countJoined body match on ai-listings#50 (anthropic)", () => {
	it.each(rows)("%s: %s:%s %s", (verdict, path, line, title, claimTitle) => {
		const claim = claims.find((c: PostedClaim) => c.title === claimTitle);
		expect(claim).toBeDefined();
		const cand = { skill: "s.md", title, path, line, severity: "P2" };
		const { joined } = countJoined([cand], [claim as PostedClaim]);
		expect(joined).toBe(verdict === "same" ? 1 : 0);
	});
});
