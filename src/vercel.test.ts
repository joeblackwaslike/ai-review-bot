import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
	functions: Record<string, { maxDuration: number }>;
};

describe("vercel.json functions", () => {
	it("gives every api/github route a 300s budget through one glob", () => {
		expect(vercel.functions["api/github/**/*.ts"]).toEqual({
			maxDuration: 300,
		});
	});

	it("keeps no explicit api/github entries beside the glob", () => {
		const explicit = Object.keys(vercel.functions).filter(
			(key) => key.startsWith("api/github/") && key !== "api/github/**/*.ts",
		);
		expect(explicit).toEqual([]);
	});

	it("ships the unified reviewer route", () => {
		expect(existsSync("api/github/reviewer/[id].ts")).toBe(true);
	});
});
