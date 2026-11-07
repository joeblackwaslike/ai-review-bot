import { describe, expect, it } from "vitest";
import {
	buildConfigRows,
	DOCS_END,
	DOCS_START,
	injectConfigSection,
	renderConfigSection,
} from "./docs.js";
import { applyEnvOverlay } from "./env.js";

describe("buildConfigRows", () => {
	const rows = buildConfigRows();
	const byPath = new Map(rows.map((r) => [r.path, r]));

	it("gives every row a non-empty description, including optional wrappers", () => {
		expect(rows.filter((r) => r.description.trim() === "")).toEqual([]);
		expect(byPath.get("reviewers.<id>.tiers.normal.effort")?.description).toBe(
			"Reasoning effort passed to the provider.",
		);
		expect(byPath.get("review.customPrompt")?.description).toBe(
			"Extra instructions appended to every agent prompt.",
		);
	});

	it("derives env names, aliases, types and defaults", () => {
		expect(byPath.get("review.delaySeconds")).toMatchObject({
			env: "AI_REVIEW_REVIEW__DELAY_SECONDS",
			alias: "REVIEW_DELAY_SECONDS (deprecated)",
			type: "number",
			default: "0",
		});
		expect(byPath.get("cli.gateDir")?.alias).toBe(
			"AI_REVIEW_GATE_DIR (permanent)",
		);
		expect(byPath.get("review.feedbackEnabled")?.type).toBe("boolean");
		expect(byPath.get("routing.docExtensions")?.type).toBe("string[]");
		expect(byPath.get("reviewers.<id>.tiers.normal.effort")?.type).toContain(
			"xhigh",
		);
	});

	it("marks leaves under an optional object as unset, not required", () => {
		for (const leaf of ["input", "cachedInput", "output"]) {
			expect(
				byPath.get(`models.<provider/model>.pricing.${leaf}`)?.default,
			).toBe("unset");
		}
		expect(byPath.get("version")?.default).toBe("required");
	});

	it("documents map sections with placeholder paths and no env var for models", () => {
		expect(byPath.get("models.<provider/model>.pricing.input")?.env).toBe(
			"none",
		);
		expect(byPath.get("reviewers.<id>.enabled")?.env).toBe(
			"AI_REVIEW_REVIEWERS__<ID>__ENABLED",
		);
	});
});

describe("renderConfigSection", () => {
	it("is deterministic", () => {
		expect(renderConfigSection()).toBe(renderConfigSection());
	});
});

describe("documented env vars", () => {
	const sampleFor = (type: string): { text: string; value: unknown } => {
		if (type === "boolean") return { text: "true", value: true };
		if (type === "number") return { text: "3", value: 3 };
		if (type.endsWith("[]")) return { text: '["x"]', value: ["x"] };
		if (type.startsWith("one of ")) {
			const first = type.slice("one of ".length).split(", ")[0] as string;
			return { text: first, value: first };
		}
		return { text: "x", value: "x" };
	};

	it("every documented non-models env var is accepted by applyEnvOverlay and lands in its path", () => {
		const documented = buildConfigRows().filter((r) => r.env !== "none");
		expect(documented.length).toBeGreaterThan(20);
		for (const row of documented) {
			const name = row.env
				.replace("<ID>", "CLAUDE")
				.replace("<SKILL>", "CODE_REVIEWER")
				.replace("<PROVIDER>", "GOOGLE");
			const path = row.path
				.replace("<id>", "claude")
				.replace("<skill>", "code-reviewer")
				.replace("<provider>", "google")
				.split(".");
			const sample = sampleFor(row.type);
			const raw = path
				.slice(0, -1)
				.reduceRight<Record<string, unknown>>(
					(inner, key) => ({ [key]: inner }),
					{},
				);
			const { value, sources } = applyEnvOverlay(raw, {
				[name]: sample.text,
			});
			expect(sources[path.join(".")], name).toBe("env");
			expect(
				path.reduce<unknown>(
					(cur, key) => (cur as Record<string, unknown>)[key],
					value,
				),
				name,
			).toEqual(sample.value);
		}
	});
});

describe("injectConfigSection", () => {
	const section = `${DOCS_START}\nBODY\n${DOCS_END}`;

	it("appends the block on a first run", () => {
		expect(injectConfigSection("hand written\n", section)).toBe(
			`hand written\n\n${section}\n`,
		);
	});

	it("replaces idempotently and keeps hand-written text around the block", () => {
		const first = injectConfigSection("before\n", section);
		const edited = `${first.trimEnd()}\n\nafter\n`;
		const once = injectConfigSection(edited, section);
		expect(injectConfigSection(once, section)).toBe(once);
		expect(once.startsWith("before\n")).toBe(true);
		expect(once.endsWith("after\n")).toBe(true);
		expect(once.split(DOCS_START)).toHaveLength(2);
	});

	it("throws when the end marker is missing", () => {
		expect(() => injectConfigSection(`a\n${DOCS_START}\nb`, section)).toThrow(
			/missing .*config-reference:end/,
		);
	});

	it("throws when only the end marker exists", () => {
		expect(() => injectConfigSection(`a\n${DOCS_END}\nb`, section)).toThrow(
			/missing .*config-reference:start/,
		);
	});

	it("throws when the markers are reversed", () => {
		expect(() =>
			injectConfigSection(`${DOCS_END}\nx\n${DOCS_START}`, section),
		).toThrow(/config-reference:end -->.* before .*config-reference:start/);
	});

	it("finds the end marker after the start when a stray end comes first", () => {
		const doc = `${DOCS_END}\nx\n${DOCS_START}\nold\n${DOCS_END}\ny\n`;
		expect(injectConfigSection(doc, section)).toBe(
			`${DOCS_END}\nx\n${section}\ny\n`,
		);
	});
});
