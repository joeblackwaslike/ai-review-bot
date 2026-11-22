/** `tokens` counts non-space characters of short seeds, despite its name. `extensions` counts candidates extended during discovery. */
export interface BudgetLimits {
	tokens: number;
	candidates: number;
	cells: number;
	extensions: number;
}

const DEFAULT_LIMITS: BudgetLimits = {
	tokens: 200_000,
	candidates: 5_000,
	cells: 16_000_000,
	extensions: 50_000,
};

/**
 * Four independent work pools for one change. Each spend call either takes the
 * full amount from its pool or takes nothing and marks the budget exhausted. Work cut short is silent.
 */
export class WorkBudget {
	readonly #limits: BudgetLimits;
	readonly #spent: BudgetLimits = {
		tokens: 0,
		candidates: 0,
		cells: 0,
		extensions: 0,
	};
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

	spendExtensions(n: number): boolean {
		return this.#spend("extensions", n);
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
