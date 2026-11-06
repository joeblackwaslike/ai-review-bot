import { registerStrategy, strategyNames } from "../strategy.js";
import { strategyA } from "./a.js";

export function registerBuiltinStrategies(): void {
	if (!strategyNames().includes(strategyA.name)) registerStrategy(strategyA);
}
