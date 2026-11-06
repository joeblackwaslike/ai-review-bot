import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry } from "ai";
import type { ProviderCredentials } from "./credentials.js";
import type { ProviderName } from "./names.js";

export function createModelRegistry(
	creds: Partial<Record<ProviderName, ProviderCredentials>>,
	opts: { fetch?: typeof fetch } = {},
) {
	const shared = (c: ProviderCredentials | undefined) => ({
		apiKey: c?.apiKey,
		baseURL: c?.baseURL,
		fetch: opts.fetch,
	});
	return createProviderRegistry(
		{
			anthropic: createAnthropic(shared(creds.anthropic)),
			openai: createOpenAI(shared(creds.openai)),
			google: createGoogleGenerativeAI(shared(creds.google)),
		},
		{ separator: "/" },
	);
}
