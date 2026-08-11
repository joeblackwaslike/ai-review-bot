import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PATH_PREFIXES } from "./route-guard";

describe("isPublicPath", () => {
	it("treats an exact prefix match as public", () => {
		expect(isPublicPath("/api/auth", PUBLIC_PATH_PREFIXES)).toBe(true);
	});

	it("treats a nested path under a public prefix as public", () => {
		expect(
			isPublicPath("/api/auth/callback/github", PUBLIC_PATH_PREFIXES),
		).toBe(true);
	});

	it("does not treat an unrelated path that merely starts with the prefix as public", () => {
		expect(isPublicPath("/api/auth-debug", PUBLIC_PATH_PREFIXES)).toBe(false);
		expect(isPublicPath("/api/authorize", PUBLIC_PATH_PREFIXES)).toBe(false);
	});

	it("treats the dashboard root and other app routes as non-public", () => {
		expect(isPublicPath("/", PUBLIC_PATH_PREFIXES)).toBe(false);
		expect(isPublicPath("/api/some-other-route", PUBLIC_PATH_PREFIXES)).toBe(
			false,
		);
	});
});
