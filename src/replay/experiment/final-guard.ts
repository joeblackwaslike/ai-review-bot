import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExperimentPlan } from "./plan.js";
import { prOf } from "./splits.js";

const MARKER = "final.marker";

export class FinalAlreadyScoredError extends Error {}

interface Marker {
	at: string;
	planHash: string;
	testFixtureIds: string[];
}

/** Burns the plan's one `--final`. Exclusive create, so a second final fails even if the first crashed. */
export function writeFinalMarker(
	root: string,
	planHash: string,
	testFixtureIds: string[],
	now: () => Date,
): void {
	const dir = join(root, planHash);
	mkdirSync(dir, { recursive: true });
	const marker: Marker = { at: now().toISOString(), planHash, testFixtureIds };
	try {
		writeFileSync(join(dir, MARKER), `${JSON.stringify(marker)}\n`, {
			flag: "wx",
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST")
			throw new FinalAlreadyScoredError(
				`plan ${planHash} already had its final scoring; revise the plan with fresh test PRs`,
			);
		throw err;
	}
}

/** A revised plan reusing test PRs of an already scored plan is exploratory. */
export function exploratoryReason(
	root: string,
	planHash: string,
	testFixtureIds: string[],
): string | null {
	if (!existsSync(root)) return null;
	const mine = new Set(testFixtureIds.map(prOf));
	for (const entry of readdirSync(root)) {
		if (entry === planHash) continue;
		const file = join(root, entry, MARKER);
		if (!existsSync(file)) continue;
		try {
			const marker = JSON.parse(readFileSync(file, "utf8")) as Marker;
			if (!Array.isArray(marker.testFixtureIds)) throw new Error("malformed");
			const shared = marker.testFixtureIds
				.map(prOf)
				.filter((id) => mine.has(id));
			if (shared.length > 0)
				return `exploratory: ${new Set(shared).size} test PR(s) were already scored by plan ${marker.planHash}`;
		} catch {
			return `exploratory: the final marker of plan ${entry} is unreadable, so its test PRs cannot be ruled out`;
		}
	}
	return null;
}

/** Non-final scoring never reads test cells; `--final` reads nothing else. */
export function readableFixtureIds(
	plan: ExperimentPlan,
	final: boolean,
): Set<string> {
	return new Set(
		plan.fixtures
			.filter((f) => (f.split === "test") === final)
			.map((f) => f.id),
	);
}

export function finalScored(root: string, planHash: string): boolean {
	return existsSync(join(root, planHash, MARKER));
}
