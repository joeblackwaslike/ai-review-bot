import { registerStrategy, strategyNames } from "../strategy.js";
import { strategyA } from "./a.js";
import { strategyA0 } from "./a0.js";

export function registerBuiltinStrategies(): void {
	for (const s of [strategyA, strategyA0])
		if (!strategyNames().includes(s.name)) registerStrategy(s);
}
