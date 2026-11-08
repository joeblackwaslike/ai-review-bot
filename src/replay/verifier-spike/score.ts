import type { Provider } from "../types.js";
import type { SpikeItem, SpikeJudge, SpikeResult } from "./types.js";

export interface Rate {
	n: number;
	dropped: number;
}

export interface CellScore {
	producer: Provider;
	judge: SpikeJudge;
	/** Confirmed labels only; these are the numbers the criteria are read from. */
	rejected: Rate;
	fixedP01: Rate;
	fixedP23: Rate;
	provisionalRejected: Rate;
	provisionalFixed: Rate;
	unverified: number;
	costUsd: number;
	rejectedDropRate: number;
	fixedP23DropRate: number;
	/** Buckets with no finding in them. A criterion with nothing to test is not met. */
	untested: string[];
	/** Drops at least 40% of rejected, drops no fixed P0 or P1, and drops at most 5% of fixed P2 and P3, with a finding in every bucket. */
	meetsCriteria: boolean;
}

export const MIN_REJECTED_DROP_RATE = 0.4;
export const MAX_FIXED_P23_DROP_RATE = 0.05;

const rate = (r: Rate): number => (r.n === 0 ? 0 : r.dropped / r.n);
const count = (r: Rate, dropped: boolean) => {
	r.n += 1;
	if (dropped) r.dropped += 1;
};

/**
 * One cell per producer family and judge. Only a real verdict counts toward a drop rate; an
 * unverified result is counted apart, since it drops nothing in production.
 */
export function scoreSpike(
	items: SpikeItem[],
	judges: SpikeJudge[],
	results: SpikeResult[],
): CellScore[] {
	const itemById = new Map(items.map((i) => [i.id, i]));
	const judgeById = new Map(judges.map((j) => [j.id, j]));
	const cells = new Map<string, CellScore>();
	for (const r of results) {
		const item = itemById.get(r.itemId);
		const judge = judgeById.get(r.judgeId);
		if (!item || !judge) continue;
		const key = `${item.producer}|${judge.id}`;
		let cell = cells.get(key);
		if (!cell) {
			cell = {
				producer: item.producer,
				judge,
				rejected: { n: 0, dropped: 0 },
				fixedP01: { n: 0, dropped: 0 },
				fixedP23: { n: 0, dropped: 0 },
				provisionalRejected: { n: 0, dropped: 0 },
				provisionalFixed: { n: 0, dropped: 0 },
				unverified: 0,
				costUsd: 0,
				rejectedDropRate: 0,
				fixedP23DropRate: 0,
				untested: [],
				meetsCriteria: false,
			};
			cells.set(key, cell);
		}
		cell.costUsd += r.outcome.costUsd;
		if (r.outcome.kind === "unverified") {
			cell.unverified += 1;
			continue;
		}
		const dropped = r.outcome.refuted;
		const severe = item.severity === "P0" || item.severity === "P1";
		if (item.label === "rejected")
			count(item.confirmed ? cell.rejected : cell.provisionalRejected, dropped);
		else if (!item.confirmed) count(cell.provisionalFixed, dropped);
		else count(severe ? cell.fixedP01 : cell.fixedP23, dropped);
	}
	return [...cells.values()].map((c) => {
		const rejectedDropRate = rate(c.rejected);
		const fixedP23DropRate = rate(c.fixedP23);
		const untested = [
			...(c.rejected.n === 0 ? ["rejected"] : []),
			...(c.fixedP01.n === 0 ? ["fixed P0/P1"] : []),
			...(c.fixedP23.n === 0 ? ["fixed P2/P3"] : []),
		];
		return {
			...c,
			rejectedDropRate,
			fixedP23DropRate,
			untested,
			meetsCriteria:
				untested.length === 0 &&
				rejectedDropRate >= MIN_REJECTED_DROP_RATE &&
				c.fixedP01.dropped === 0 &&
				fixedP23DropRate <= MAX_FIXED_P23_DROP_RATE,
		};
	});
}

const show = (r: Rate): string =>
	r.n === 0 ? "0/0" : `${r.dropped}/${r.n} (${Math.round(rate(r) * 100)}%)`;

export function formatSpikeReport(cells: CellScore[]): string {
	const lines = [
		"| Producer | Judge | Tier | Rejected dropped | Fixed P0/P1 dropped | Fixed P2/P3 dropped | Unverified | Cost | Meets criteria |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
	];
	for (const c of cells)
		lines.push(
			`| ${c.producer} | ${c.judge.model} | ${c.judge.tier} | ${show(c.rejected)} | ${show(c.fixedP01)} | ${show(c.fixedP23)} | ${c.unverified} | $${c.costUsd.toFixed(2)} | ${c.untested.length > 0 ? "insufficient data" : c.meetsCriteria ? "yes" : "no"} |`,
		);
	return lines.join("\n");
}
