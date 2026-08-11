import "server-only";
import { getDb } from "../../src/improve/db/client";
import { listFindingOutcomes } from "../../src/improve/db/repo";
import {
	type ProposalPlan,
	planProposals,
	thresholdsFromEnv,
} from "../../src/improve/issues";
import {
	computeSeverityReliability,
	computeSkillSignals,
	detectDuplicateClusters,
} from "../../src/improve/trends";

export interface DashboardData {
	outcomes: Awaited<ReturnType<typeof listFindingOutcomes>>;
	severity: ReturnType<typeof computeSeverityReliability>;
	duplicates: ReturnType<typeof detectDuplicateClusters>;
	skills: ReturnType<typeof computeSkillSignals>;
	proposals: ProposalPlan[];
}

export async function loadDashboardData(): Promise<DashboardData> {
	const outcomes = await listFindingOutcomes(getDb());
	return {
		outcomes,
		severity: computeSeverityReliability(outcomes),
		duplicates: detectDuplicateClusters(outcomes),
		skills: computeSkillSignals(outcomes),
		proposals: planProposals(outcomes, thresholdsFromEnv(process.env)),
	};
}
