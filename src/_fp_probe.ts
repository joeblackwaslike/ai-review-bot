// Throwaway probe to validate the review bot's epistemic guardrails (PR will be
// closed, file deleted). It deliberately recreates two previously-observed
// false positives:
//   1. `provider.responses(model)` is a REAL @ai-sdk/openai method — a prior
//      review falsely claimed it "does not exist and throws at runtime".
//   2. `import type { ResolvedAuth }` is a type-only import (erased at compile
//      time) — a prior review falsely claimed it "pollutes the runtime bundle".
import { createOpenAI } from "@ai-sdk/openai";
import type { ResolvedAuth } from "./auth.js";

export function fpProbe(_auth: ResolvedAuth): unknown {
	const provider = createOpenAI({ apiKey: "test" });
	return provider.responses("gpt-5.1");
}
