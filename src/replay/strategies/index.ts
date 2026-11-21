import { registerStrategy, strategyNames } from "../strategy.js";
import { strategyA } from "./a.js";
import { strategyA0 } from "./a0.js";
import { strategyF0 } from "./f0.js";
import { strategyF1 } from "./f1.js";

export function registerBuiltinStrategies(): void {
	for (const s of [strategyA, strategyA0, strategyF0, strategyF1])
		if (!strategyNames().includes(s.name)) registerStrategy(s);
}
