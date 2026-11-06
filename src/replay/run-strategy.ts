import { REVIEWER_TUNING } from "../reviewer-tuning.js";
import { toCandidates } from "./live-wiring.js";
import type {
	ReviewStrategy,
	StrategyInput,
	StrategyResult,
} from "./strategy.js";
import { postFilterTrace } from "./trace.js";

/** Runs a strategy, then recomputes `candidates` and `posted` from its agent
 * reviews through the production posting path, so `posted` means the same thing
 * for every strategy. */
export async function runStrategy(
	strategy: ReviewStrategy,
	input: StrategyInput,
): Promise<StrategyResult> {
	const result = await strategy.run(input);
	const { posted } = postFilterTrace({
		agentReviews: result.agentReviews,
		ledger: input.history.ledger,
		files: input.files,
		tuning: REVIEWER_TUNING,
	});
	return {
		...result,
		candidates: toCandidates(result.agentReviews),
		posted,
	};
}
