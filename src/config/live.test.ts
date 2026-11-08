import { describe, expect, it } from "vitest";
import { isLivePath, LIVE_PATTERNS } from "./live.js";

describe("isLivePath", () => {
	it("is true for every pattern with a concrete reviewer id", () => {
		for (const pattern of LIVE_PATTERNS) {
			const path = pattern.split(".").map((s) => (s === "*" ? "claude" : s));
			expect(isLivePath(path), pattern).toBe(true);
		}
	});

	it("accepts a docs placeholder for a map key", () => {
		expect(isLivePath(["reviewers", "<id>", "enabled"])).toBe(true);
	});

	it("is false for settings that need a restart", () => {
		for (const path of [
			["reviewers", "claude", "tiers", "normal", "model"],
			["reviewers", "claude", "appId"],
			["review", "command"],
			["models", "anthropic/claude-haiku-5-5", "pricing", "input"],
			["reviewers", "claude", "enabled", "extra"],
		]) {
			expect(isLivePath(path), path.join(".")).toBe(false);
		}
	});
});
