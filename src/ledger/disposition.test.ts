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

	describe("acknowledged", () => {
		const status = (body: string) =>
			classifyReplies([reply(body)], anyone)?.status ?? null;

		it("acknowledges an agreeing reply that promises a fix", () => {
			expect(status("good catch, will fix")).toBe("acknowledged");
			expect(status("You're right, I'll fix this")).toBe("acknowledged");
			expect(status("agreed \u2014 will address")).toBe("acknowledged");
			expect(status("You're right, I'll fix this.")).toBe("acknowledged");
		});

		it("lets a fix commit, a deferral or a rejection win", () => {
			expect(status("good catch, fixed in abc1234")).toBe("fixed");
			expect(status("good catch, will address later")).toBe("deferred");
			expect(status("good catch, will fix later")).toBe("deferred");
			expect(status("you're right but won't fix")).toBe("rejected");
		});

		it("treats every spelling of follow-up as deferred", () => {
			expect(status("Good catch! I'll fix this in a follow up")).toBe(
				"deferred",
			);
			expect(status("will do in a follow-up")).toBe("deferred");
			expect(status("will do in a followup")).toBe("deferred");
			expect(status("tracking it in the follow-ups list")).toBe("deferred");
		});

		it("does not read follow plus an up- word as a follow-up", () => {
			expect(status("good catch, I'll fix it to follow upstream")).toBe(
				"acknowledged",
			);
			expect(
				status("you're right, I'll update it to follow updated docs"),
			).toBe("acknowledged");
		});

		it("treats a fix promised for later, up to three words on, as deferred", () => {
			expect(status("Good catch, I'll fix this later")).toBe("deferred");
			expect(status("agreed, we'll fix it later")).toBe("deferred");
			expect(status("good catch, I'll address the parser bit later")).toBe(
				"deferred",
			);
		});

		it("treats gonna/going-to fix-later phrasing as deferred too", () => {
			expect(status("Good catch, gonna fix this later")).toBe("deferred");
			expect(status("good catch, I'm going to fix this later")).toBe(
				"deferred",
			);
		});

		it("turns fixed when a later reply cites the commit", () => {
			const d = classifyReplies(
				[reply("good catch, will fix"), reply("fixed in a1b2c3d4")],
				anyone,
			);
			expect(d?.status).toBe("fixed");
		});

		it("does not acknowledge hedges, negations or a promise without agreement", () => {
			expect(status("not sure this is right")).toBeNull();
			expect(status("agreed, not sure I'll fix it")).toBeNull();
			expect(status("agreed, we never said we'll fix it")).toBeNull();
			expect(status("will fix")).toBeNull();
		});

		it("does not acknowledge a disagreement that borrows agreeing words", () => {
			expect(
				status("makes sense, but I'll change it only if X breaks"),
			).toBeNull();
			expect(status("agreed, we depend on it")).toBeNull();
			expect(status("fair point, I don't think I'll fix it")).toBeNull();
			expect(status("we agreed earlier that I'll fix the rest")).toBeNull();
			expect(
				status("> good catch, will fix\n\nThat is not a regression"),
			).toBeNull();
		});

		it("ignores a reply from a non-decider", () => {
			const d = classifyReplies(
				[reply("good catch, will fix", "bot")],
				(r) => r.author !== "bot",
			);
			expect(d).toBeNull();
		});
	});
});
