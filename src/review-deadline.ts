export const VERCEL_FUNCTION_LIMIT_MS = 300_000;
export const FINISH_RESERVE_MS = 60_000;

export function agentDeadline(input: {
	agentStartMs: number;
	agentBudgetMs: number;
	requestStartedAtMs?: number;
}): number {
	const budgeted = input.agentStartMs + input.agentBudgetMs;
	if (input.requestStartedAtMs === undefined) return budgeted;
	return Math.min(
		budgeted,
		input.requestStartedAtMs + VERCEL_FUNCTION_LIMIT_MS - FINISH_RESERVE_MS,
	);
}
