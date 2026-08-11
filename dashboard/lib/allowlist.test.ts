import { describe, expect, it } from "vitest";
import { isAllowedLogin, parseAllowlist } from "./allowlist.js";

describe("parseAllowlist", () => {
	it("splits, trims, and lowercases comma-separated logins", () => {
		expect(parseAllowlist(" Joeblackwaslike , other-user ")).toEqual([
			"joeblackwaslike",
			"other-user",
		]);
	});

	it("returns an empty array for undefined or blank input", () => {
		expect(parseAllowlist(undefined)).toEqual([]);
		expect(parseAllowlist("")).toEqual([]);
		expect(parseAllowlist(" , , ")).toEqual([]);
	});
});

describe("isAllowedLogin", () => {
	const allowlist = ["joeblackwaslike"];

	it("admits a login on the allowlist, case-insensitively", () => {
		expect(isAllowedLogin("JoeBlackWasLike", allowlist)).toBe(true);
	});

	it("rejects a login not on the allowlist", () => {
		expect(isAllowedLogin("someone-else", allowlist)).toBe(false);
	});

	it("rejects a null or undefined login", () => {
		expect(isAllowedLogin(null, allowlist)).toBe(false);
		expect(isAllowedLogin(undefined, allowlist)).toBe(false);
	});
});
