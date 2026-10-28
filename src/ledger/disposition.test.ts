import { describe, expect, it } from "vitest";
import { classifyReplies, type DecisionReply } from "./disposition.js";

const reply = (
	body: string,
	author = "dev",
	createdAt = "2026-01-01",
): DecisionReply => ({ author, createdAt, body });
const anyone = () => true;

describe("classifyReplies", () => {
	it("classifies deferred", () => {
		const d = classifyReplies([reply("out of scope, follow-up PR")], anyone);
		expect(d?.status).toBe("deferred");
		expect(d?.reason).toBe("out of scope, follow-up PR");
		expect(d?.evidence).toEqual(["2026-01-01|out of scope, follow-up PR"]);
	});

	it("classifies rejected", () => {
		expect(classifyReplies([reply("intentional")], anyone)?.status).toBe(
			"rejected",
		);
		expect(classifyReplies([reply("kept as is")], anyone)?.status).toBe(
			"rejected",
		);
	});

	it("classifies fixed by sha but not by year", () => {
		expect(classifyReplies([reply("fixed in a1b2c3d4")], anyone)?.status).toBe(
			"fixed",
		);
		expect(classifyReplies([reply("shipped in 2024")], anyone)).toBeNull();
	});

	it("prefers deferred over rejected", () => {
		const d = classifyReplies(
			[reply("intentional"), reply("follow-up")],
			anyone,
		);
		expect(d?.status).toBe("deferred");
	});

	it("ignores non-deciders", () => {
		expect(
			classifyReplies([reply("intentional", "bot")], (r) => r.author === "dev"),
		).toBeNull();
	});

	it("stamps empty createdAt as unknown", () => {
		expect(
			classifyReplies([reply("intentional", "dev", "")], anyone)?.evidence,
		).toEqual(["unknown|intentional"]);
	});

	it("returns null when nothing matches", () => {
		expect(classifyReplies([reply("thanks")], anyone)).toBeNull();
	});
});
