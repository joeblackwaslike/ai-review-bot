import { describe, expect, it } from "vitest";
import { buildDiffModel } from "../../diff-model/index.js";
import type {
	DiffModel,
	Divergence,
	Operation,
	Span,
} from "../../diff-model/types.js";
import { scoreDetection } from "./detect.js";
import { type SeedReviewInput, seedReviewInput } from "./input.js";
import { listSeeds, type SeedOperation } from "./schema.js";

const span = (
	filename: string,
	side: "base" | "head",
	startLine: number,
	endLine: number,
): Span => ({ filename, side, startLine, endLine, shown: "full" });

const truthSpan = (
	filename: string,
	side: "base" | "head",
	startLine: number,
	endLine: number,
) => ({ filename, side, startLine, endLine });

function modelOf(operations: Operation[]): DiffModel {
	return {
		files: [],
		operations,
		facts: { testsChanged: "unknown", intentClaims: [] },
		droppedClaims: 0,
	};
}

function relocation(divergences: Divergence[] = []): Operation {
	return {
		id: "relocation-1",
		type: "relocation",
		from: [span("a.py", "base", 10, 30)],
		to: [span("b.py", "head", 4, 24)],
		exact: divergences.length === 0,
		divergences,
		reviewWeight: 1,
	};
}

const expectedRelocation = (
	divergences: SeedOperation["divergences"] = [],
): SeedOperation => ({
	type: "relocation",
	from: [truthSpan("a.py", "base", 10, 30)],
	to: [truthSpan("b.py", "head", 4, 24)],
	divergences,
});

const changedLine: Divergence = {
	kind: "changed",
	class: "code",
	base: span("a.py", "base", 20, 20),
	head: span("b.py", "head", 14, 14),
};

describe("scoreDetection", () => {
	it("matches an expected relocation by spans and divergences", () => {
		const result = scoreDetection(
			[
				expectedRelocation([
					{
						kind: "changed",
						class: "code",
						base: truthSpan("a.py", "base", 20, 20),
						head: truthSpan("b.py", "head", 14, 14),
					},
				]),
			],
			modelOf([relocation([changedLine])]),
		);
		expect(result).toEqual({
			matched: 1,
			missing: [],
			unexpected: [],
			divergencesMissed: 0,
			divergencesExtra: 0,
		});
	});

	it("reports an unexpected operation", () => {
		const found = relocation();
		const result = scoreDetection([], modelOf([found]));
		expect(result.unexpected).toEqual([found]);
		expect(result.matched).toBe(0);
	});

	it("reports an expected operation the model does not contain", () => {
		const expected = expectedRelocation();
		const result = scoreDetection([expected], modelOf([]));
		expect(result.missing).toEqual([expected]);
		expect(result.matched).toBe(0);
	});

	it("does not match an operation at different spans", () => {
		const moved: Operation = {
			...relocation(),
			to: [span("other.py", "head", 4, 24)],
		};
		const result = scoreDetection([expectedRelocation()], modelOf([moved]));
		expect(result.missing).toHaveLength(1);
		expect(result.unexpected).toEqual([moved]);
	});

	const withTo = (to: Span[]): Operation => ({ ...relocation(), to });

	it("does not match a found span that only grazes the truth span", () => {
		const result = scoreDetection(
			[expectedRelocation()],
			modelOf([withTo([span("b.py", "head", 24, 40)])]),
		);
		expect(result.missing).toHaveLength(1);
	});

	it("does not match a clipped span", () => {
		const result = scoreDetection(
			[expectedRelocation()],
			modelOf([withTo([span("b.py", "head", 4, 20)])]),
		);
		expect(result.missing).toHaveLength(1);
	});

	it("does not match an over-wide span but allows one line at each edge", () => {
		const wide = scoreDetection(
			[expectedRelocation()],
			modelOf([withTo([span("b.py", "head", 2, 24)])]),
		);
		expect(wide.missing).toHaveLength(1);
		const edge = scoreDetection(
			[expectedRelocation()],
			modelOf([withTo([span("b.py", "head", 3, 25)])]),
		);
		expect(edge.matched).toBe(1);
	});

	it("lets one found span satisfy only one truth span", () => {
		const expected: SeedOperation = {
			...expectedRelocation(),
			to: [truthSpan("b.py", "head", 4, 24), truthSpan("b.py", "head", 4, 24)],
		};
		const result = scoreDetection(
			[expected],
			modelOf([
				withTo([span("b.py", "head", 4, 24), span("c.py", "head", 1, 2)]),
			]),
		);
		expect(result.missing).toHaveLength(1);
	});

	it("reports a missing divergence", () => {
		const result = scoreDetection(
			[
				expectedRelocation([
					{
						kind: "changed",
						class: "code",
						base: truthSpan("a.py", "base", 20, 20),
						head: truthSpan("b.py", "head", 14, 14),
					},
				]),
			],
			modelOf([relocation()]),
		);
		expect(result.matched).toBe(1);
		expect(result.divergencesMissed).toBe(1);
		expect(result.divergencesExtra).toBe(0);
	});

	it("counts a divergence the truth does not list as extra", () => {
		const result = scoreDetection(
			[expectedRelocation()],
			modelOf([relocation([changedLine])]),
		);
		expect(result.matched).toBe(1);
		expect(result.divergencesMissed).toBe(0);
		expect(result.divergencesExtra).toBe(1);
	});

	const truthDivergence = (cls: "comment-only" | "rename" | "code") => ({
		kind: "changed" as const,
		class: cls,
		base: truthSpan("a.py", "base", 20, 20),
		head: truthSpan("b.py", "head", 14, 14),
	});

	it("treats a divergence of another class as one missed and one extra", () => {
		const result = scoreDetection(
			[expectedRelocation([truthDivergence("comment-only")])],
			modelOf([relocation([changedLine])]),
		);
		expect(result.matched).toBe(1);
		expect(result.divergencesMissed).toBe(1);
		expect(result.divergencesExtra).toBe(1);
	});

	it("matches a divergence of the same class", () => {
		const result = scoreDetection(
			[expectedRelocation([truthDivergence("code")])],
			modelOf([relocation([changedLine])]),
		);
		expect(result.divergencesMissed).toBe(0);
		expect(result.divergencesExtra).toBe(0);
	});

	it("does not match an operation whose exactness differs from the truth", () => {
		const found = relocation();
		const result = scoreDetection(
			[{ ...expectedRelocation(), exact: false }],
			modelOf([found]),
		);
		expect(result.matched).toBe(0);
		expect(result.missing).toHaveLength(1);
		expect(result.unexpected).toEqual([found]);
	});

	it("matches an operation whose exactness equals the truth, or is not stated", () => {
		expect(
			scoreDetection(
				[{ ...expectedRelocation(), exact: true }],
				modelOf([relocation()]),
			).matched,
		).toBe(1);
		expect(
			scoreDetection([expectedRelocation()], modelOf([relocation()])).matched,
		).toBe(1);
	});

	const mechanical = (reason?: "whitespace" | "imports"): Operation => ({
		id: "mechanical-1",
		type: "mechanical",
		from: [span("a.py", "base", 3, 3)],
		to: [span("a.py", "head", 3, 3)],
		exact: true,
		divergences: [],
		reviewWeight: 0,
		reason,
	});

	const expectedMechanical = (
		reason?: "whitespace" | "imports",
	): SeedOperation => ({
		type: "mechanical",
		from: [truthSpan("a.py", "base", 3, 3)],
		to: [truthSpan("a.py", "head", 3, 3)],
		divergences: [],
		reason,
	});

	it("does not match a mechanical operation with a different reason", () => {
		const result = scoreDetection(
			[expectedMechanical("imports")],
			modelOf([mechanical("whitespace")]),
		);
		expect(result.matched).toBe(0);
		expect(result.missing).toHaveLength(1);
		expect(result.unexpected).toHaveLength(1);
	});

	it("matches a mechanical operation with the same reason", () => {
		expect(
			scoreDetection(
				[expectedMechanical("whitespace")],
				modelOf([mechanical("whitespace")]),
			).matched,
		).toBe(1);
	});
});

function modelOfSeed(input: SeedReviewInput): DiffModel {
	const files = input.files.map((f) => ({
		...f,
		additions: f.additions ?? 0,
		deletions: f.deletions ?? 0,
	}));
	return buildDiffModel({
		scopeFiles: files,
		prFiles: files,
		prFilesComplete: true,
		title: input.title,
		body: input.body,
	});
}

const SLOW = 120_000;

const MOVES_BELOW_MINIMUM = new Set([
	"REL-01/original",
	"REL-01/v1",
	"REL-01/v3",
]);

describe("seed operation truth", () => {
	it(
		"every committed seed's detection matches its truth operations",
		async () => {
			const seeds = (await listSeeds()).filter(
				(s) => !MOVES_BELOW_MINIMUM.has(s.id),
			);
			expect(seeds).toHaveLength(22);
			for (const seed of seeds) {
				const input = await seedReviewInput(seed);
				try {
					const model = modelOfSeed(input);
					const result = scoreDetection(seed.truth.operations, model);
					expect(result.missing, `${seed.id} missing`).toEqual([]);
					expect(result.unexpected, `${seed.id} unexpected`).toEqual([]);
					expect(result.divergencesMissed, `${seed.id} missed`).toBe(0);
					expect(result.divergencesExtra, `${seed.id} extra`).toBe(0);
				} finally {
					await input.cleanup();
				}
			}
		},
		SLOW,
	);

	it("keeps a rename and a mechanical operation the model really emits in the truth", async () => {
		const types = (await listSeeds()).flatMap((seed) =>
			seed.truth.operations.map((op) => op.type),
		);
		expect(types).toContain("rename");
		expect(types).toContain("mechanical");
	});

	it(
		"misses exactly the relocation of a 3 or 4 line function, under the 5 line minimum",
		async () => {
			const gaps = (await listSeeds()).filter((s) =>
				MOVES_BELOW_MINIMUM.has(s.id),
			);
			expect(gaps).toHaveLength(MOVES_BELOW_MINIMUM.size);
			for (const seed of gaps) {
				const input = await seedReviewInput(seed);
				try {
					const model = modelOfSeed(input);
					const result = scoreDetection(seed.truth.operations, model);
					expect(
						result.missing.map((m) => m.type),
						seed.id,
					).toEqual(["relocation"]);
					expect(result.unexpected, seed.id).toEqual([]);
				} finally {
					await input.cleanup();
				}
			}
		},
		SLOW,
	);

	it(
		"gives the REL-10 variants a description that claims no functional change",
		async () => {
			const rel10 = (await listSeeds()).filter((s) => s.opId === "REL-10");
			const described = rel10.filter((s) => s.variant !== "clean");
			expect(described).toHaveLength(4);
			for (const seed of described) {
				const input = await seedReviewInput(seed);
				try {
					expect(input.title, seed.id).not.toBe("");
					expect(input.body, seed.id).toContain("no functional change");
				} finally {
					await input.cleanup();
				}
			}
		},
		SLOW,
	);
});
