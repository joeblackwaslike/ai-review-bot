import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbSingleton } from "./client.js";

describe("getDb", () => {
	afterEach(() => {
		resetDbSingleton();
		vi.unstubAllEnvs();
	});

	it("throws a clear error when DATABASE_URL is unset", () => {
		vi.stubEnv("DATABASE_URL", "");
		expect(() => getDb()).toThrow(/DATABASE_URL/);
	});

	it("returns the same instance on repeated calls", () => {
		vi.stubEnv("DATABASE_URL", "postgres://user:pw@localhost:5432/db");
		const a = getDb();
		const b = getDb();
		expect(a).toBe(b);
	});
});
