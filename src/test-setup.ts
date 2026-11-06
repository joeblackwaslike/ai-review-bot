import { beforeEach } from "vitest";
import { resetConfigForTests } from "./config/load.js";
import { setPriceTable } from "./pricing.js";

const price = (input: number, cachedInput: number, output: number) => ({
	input,
	cachedInput,
	output,
});

beforeEach(() => {
	resetConfigForTests();
	setPriceTable({
		"anthropic/claude-haiku-5-5": price(0.1, 0.01, 0.5),
		"anthropic/claude-sonnet-5-5": price(2, 0.1, 10),
		"anthropic/claude-opus-5-5": price(4, 0.2, 20),
		"openai/gpt-6-luna": price(0.1, 0.01, 0.5),
		"openai/gpt-6-1-sol": price(2, 0.1, 10),
	});
});
