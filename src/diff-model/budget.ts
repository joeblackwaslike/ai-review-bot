/** `tokens` counts non-space characters of short seeds, despite its name. */
export interface BudgetLimits {
	tokens: number;
	candidates: number;
	cells: number;
}

const DEFAULT_LIMITS: BudgetLimits = {
	tokens: 200_000,
	candidates: 5_000,
	cells: 16_000_000,
};

/**
 * Three independent work pools for one change. Each spend call either takes the
 * full amount from its pool or takes nothing and marks the budget exhausted. Nothing
 * reports the exhaustion to the caller beyond `exhausted`, so work cut short is silent.
 */
export class WorkBudget {
	readonly #limits: BudgetLimits;
	readonly #spent: BudgetLimits = { tokens: 0, candidates: 0, cells: 0 };
	#exhausted = false;

	constructor(limits: Partial<BudgetLimits> = {}) {
		this.#limits = { ...DEFAULT_LIMITS, ...limits };
	}

	get exhausted(): boolean {
		return this.#exhausted;
	}

	spendTokens(n: number): boolean {
		return this.#spend("tokens", n);
	}

	spendCandidates(n: number): boolean {
		return this.#spend("candidates", n);
	}

	spendCells(n: number): boolean {
		return this.#spend("cells", n);
	}

	#spend(pool: keyof BudgetLimits, n: number): boolean {
		if (this.#spent[pool] + n > this.#limits[pool]) {
			this.#exhausted = true;
			return false;
		}
		this.#spent[pool] += n;
		return true;
	}
}
