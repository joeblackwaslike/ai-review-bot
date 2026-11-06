import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultSeedsRoot, listSeeds } from "./schema.js";

describe("defaultSeedsRoot", () => {
	const real = join(process.cwd(), "src", "replay", "seeds");

	it("resolves to the committed seeds from source", async () => {
		expect(defaultSeedsRoot(import.meta.url)).toBe(real);
		expect(await listSeeds()).toHaveLength(25);
	});

	it("resolves to the committed seeds from a built dist path", () => {
		const built = pathToFileURL(
			join(process.cwd(), "dist", "replay", "seeds", "schema.js"),
		).href;
		expect(defaultSeedsRoot(built)).toBe(real);
	});
});
