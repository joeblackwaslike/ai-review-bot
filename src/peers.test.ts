import { describe, expect, it } from "vitest";
import { shouldRunNow, summarizePeers } from "./peers.js";

const HEAD = "abc123";

function review(login: string, sha = HEAD) {
	return { user: { login }, commit_id: sha };
}

describe("summarizePeers", () => {
	it("counts a peer that reviewed the current head as arrived", () => {
		const status = summarizePeers([review("coderabbitai[bot]")], HEAD);
		expect(status).toEqual({
			arrived: ["coderabbitai[bot]"],
			seenOnPr: ["coderabbitai[bot]"],
		});
	});

	// A peer's review of an older commit says nothing about the diff we are
	// about to review, so it must not satisfy the wait.
	it("counts a stale peer review as engaged but not arrived", () => {
		const status = summarizePeers([review("coderabbitai[bot]", "old")], HEAD);
		expect(status.arrived).toEqual([]);
		expect(status.seenOnPr).toEqual(["coderabbitai[bot]"]);
	});

	it("ignores our own bots — waiting for ourselves would deadlock", () => {
		const status = summarizePeers(
			[review("anthropicreviewbot[bot]"), review("codexreviewbot[bot]")],
			HEAD,
		);
		expect(status).toEqual({ arrived: [], seenOnPr: [] });
	});

	it("ignores humans", () => {
		expect(summarizePeers([review("joeblackwaslike")], HEAD).seenOnPr).toEqual(
			[],
		);
	});

	it("deduplicates a peer that reviewed several times", () => {
		const status = summarizePeers(
			[review("sourcery-ai[bot]"), review("sourcery-ai[bot]")],
			HEAD,
		);
		expect(status.arrived).toEqual(["sourcery-ai[bot]"]);
	});
});

describe("shouldRunNow", () => {
	const base = { peersExpectedInRepo: true, attempt: 1, maxAttempts: 5 };

	it("runs once every engaged peer has reviewed the current head", () => {
		expect(
			shouldRunNow({
				...base,
				status: {
					arrived: ["coderabbitai[bot]"],
					seenOnPr: ["coderabbitai[bot]"],
				},
			}),
		).toEqual({ run: true, reason: "peers-arrived" });
	});

	it("keeps waiting while an engaged peer has not caught up to the head", () => {
		expect(
			shouldRunNow({
				...base,
				status: {
					arrived: ["coderabbitai[bot]"],
					seenOnPr: ["coderabbitai[bot]", "sourcery-ai[bot]"],
				},
			}),
		).toEqual({ run: false, reason: "wait" });
	});

	// A repo with no review bots installed should never wait at all.
	it("runs immediately when no peer is expected in this repo", () => {
		expect(
			shouldRunNow({
				...base,
				peersExpectedInRepo: false,
				status: { arrived: [], seenOnPr: [] },
			}),
		).toEqual({ run: true, reason: "no-peers-expected" });
	});

	it("still waits in a repo where peers exist but none has posted yet", () => {
		expect(
			shouldRunNow({ ...base, status: { arrived: [], seenOnPr: [] } }),
		).toEqual({ run: false, reason: "wait" });
	});

	// A peer that never arrives must not starve us — which is exactly how our
	// own Codex bot went unreviewed across an entire PR.
	it("runs at the ceiling rather than waiting forever", () => {
		expect(
			shouldRunNow({
				...base,
				attempt: 5,
				status: { arrived: [], seenOnPr: ["coderabbitai[bot]"] },
			}),
		).toEqual({ run: true, reason: "ceiling" });
	});

	it("prefers peers-arrived over the ceiling when both hold", () => {
		expect(
			shouldRunNow({
				...base,
				attempt: 99,
				status: {
					arrived: ["sourcery-ai[bot]"],
					seenOnPr: ["sourcery-ai[bot]"],
				},
			}).reason,
		).toBe("peers-arrived");
	});
});
