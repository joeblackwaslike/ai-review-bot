import { describe, expect, it } from "vitest";
import { isAllowedLogin, parseAllowlist, reviewToken } from "./allowlist.js";

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

describe("reviewToken", () => {
	const allowlist = ["joeblackwaslike"];

	it("captures the profile login at sign-in and allows it", () => {
		expect(reviewToken(undefined, "joeblackwaslike", allowlist)).toEqual({
			login: "joeblackwaslike",
			allowed: true,
		});
	});

	it("keeps the token's existing login on a profile-less refresh", () => {
		expect(reviewToken("joeblackwaslike", undefined, allowlist)).toEqual({
			login: "joeblackwaslike",
			allowed: true,
		});
	});

	it("revokes access on refresh once the login is removed from the allowlist", () => {
		expect(reviewToken("someone-else", undefined, allowlist)).toEqual({
			login: "someone-else",
			allowed: false,
		});
	});

	it("rejects a token with no login at all", () => {
		expect(reviewToken(undefined, undefined, allowlist)).toEqual({
			login: undefined,
			allowed: false,
		});
	});
});
