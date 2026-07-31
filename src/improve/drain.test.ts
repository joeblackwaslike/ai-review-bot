import { describe, expect, it } from "vitest";
import type { FeedbackEvent } from "../feedback/types.js";
import { mapKvEventToRaw, parseEvents } from "./drain.js";

function event(over: Partial<FeedbackEvent> = {}): FeedbackEvent {
	return {
		commentId: 101,
		provider: "anthropic",
		owner: "o",
		repo: "r",
		pr: 7,
		path: "src/x.ts",
		line: 12,
		skills: ["code-reviewer.md"],
		title: "a finding",
		verdict: "confused",
		reactor: "joeblackwaslike",
		reactedAtMs: Date.parse("2026-07-30T00:00:00Z"),
		capturedAtMs: Date.parse("2026-07-30T01:00:00Z"),
		...over,
	};
}

describe("mapKvEventToRaw", () => {
	it("carries the verdict and provenance through unchanged", () => {
		expect(mapKvEventToRaw(event())).toMatchObject({
			source: "inline_reaction",
			provider: "anthropic",
			commentId: 101,
			verdict: "confused",
			actor: "joeblackwaslike",
			skills: ["code-reviewer.md"],
			title: "a finding",
		});
	});

	// The drain and the backfill can both see the same reaction; identical keys
	// are what stop it being counted twice.
	it("builds the same dedup key the backfill writes", () => {
		expect(mapKvEventToRaw(event()).dedupKey).toBe(
			"react:inline_reaction:101:joeblackwaslike:confused",
		);
	});

	it("separates two verdicts from one actor on one comment", () => {
		expect(mapKvEventToRaw(event({ verdict: "up" })).dedupKey).not.toBe(
			mapKvEventToRaw(event({ verdict: "down" })).dedupKey,
		);
	});

	it("converts the reaction timestamp to a Date", () => {
		expect(mapKvEventToRaw(event()).eventAt).toEqual(
			new Date("2026-07-30T00:00:00Z"),
		);
	});
});

describe("parseEvents", () => {
	it("parses well-formed entries", () => {
		const { events, malformed } = parseEvents([JSON.stringify(event())]);
		expect(events).toHaveLength(1);
		expect(malformed).toBe(0);
	});

	// One bad write must not strand every event behind it.
	it("skips unparseable entries without dropping the good ones", () => {
		const { events, malformed } = parseEvents([
			"{not json",
			JSON.stringify(event()),
		]);
		expect(events).toHaveLength(1);
		expect(malformed).toBe(1);
	});

	it("rejects a parseable object that is not a feedback event", () => {
		const { events, malformed } = parseEvents([JSON.stringify({ hello: 1 })]);
		expect(events).toEqual([]);
		expect(malformed).toBe(1);
	});
});
