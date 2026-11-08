import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	fixtureFamily,
	type LabelFile,
	type PostedClaim,
	type ReplayFixture,
} from "../types.js";
import type { SpikeItem } from "./types.js";

export interface SelectResult {
	items: SpikeItem[];
	skipped: {
		notFixedOrRejected: number;
		noPath: number;
		missingClaim: number;
		noLabelsFile: number;
		unsupportedProvider: number;
	};
}

function readJson<T>(path: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (err) {
		throw new Error(
			`${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

const FIXTURE_FILE = /^(?!.*\.(labels(\.proposed)?|classes)\.json$).+\.json$/;

/**
 * Every fixed or rejected labelled claim that has a file path, with the head sha of the round it
 * was posted in. Deferred and unadjudicated labels are not a clear right answer, and a claim with
 * no path has no file for the verifier to read.
 */
export function selectItems(dir: string): SelectResult {
	const items: SpikeItem[] = [];
	const skipped = {
		notFixedOrRejected: 0,
		noPath: 0,
		missingClaim: 0,
		noLabelsFile: 0,
		unsupportedProvider: 0,
	};
	for (const name of readdirSync(dir).sort()) {
		if (!FIXTURE_FILE.test(name)) continue;
		const id = name.slice(0, -".json".length);
		const labelsPath = join(dir, `${id}.labels.json`);
		const fixture = readJson<Partial<ReplayFixture>>(join(dir, name));
		if (fixture.schemaVersion !== 1 || !fixture.rounds) continue;
		if (!existsSync(labelsPath)) {
			skipped.noLabelsFile += 1;
			continue;
		}
		let producer: ReturnType<typeof fixtureFamily>;
		try {
			producer = fixtureFamily(fixture as ReplayFixture);
		} catch {
			skipped.unsupportedProvider += 1;
			continue;
		}
		const labels = readJson<LabelFile>(labelsPath);
		const claims = new Map<string, { claim: PostedClaim; headSha: string }>();
		for (const round of fixture.rounds)
			for (const claim of round.claims)
				claims.set(claim.id, { claim, headSha: round.headSha });
		for (const l of labels.labels) {
			if (l.label !== "fixed" && l.label !== "rejected") {
				skipped.notFixedOrRejected += 1;
				continue;
			}
			const found = claims.get(l.claimId);
			if (!found) {
				skipped.missingClaim += 1;
				continue;
			}
			if (found.claim.path === null) {
				skipped.noPath += 1;
				continue;
			}
			items.push({
				id: `${id}:${l.claimId}`,
				fixtureId: id,
				producer,
				confirmed: l.confirmed,
				label: l.label,
				owner: fixture.owner as string,
				repo: fixture.repo as string,
				headSha: found.headSha,
				path: found.claim.path,
				line: found.claim.line,
				severity: found.claim.severity,
				title: found.claim.title,
				text: found.claim.text,
			});
		}
	}
	return { items, skipped };
}
