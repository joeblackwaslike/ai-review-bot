import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createModelRegistry } from "./registry.js";

const bodies = {
	anthropic: {
		id: "m",
		type: "message",
		role: "assistant",
		model: "x",
		content: [{ type: "text", text: "hi" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 1, output_tokens: 1 },
	},
	openai: {
		id: "r",
		object: "response",
		created_at: 1,
		model: "x",
		output: [
			{
				type: "message",
				id: "m",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "hi", annotations: [] }],
			},
		],
		usage: { input_tokens: 1, output_tokens: 1 },
	},
	google: {
		candidates: [
			{
				content: { role: "model", parts: [{ text: "hi" }] },
				finishReason: "STOP",
			},
		],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
	},
};

async function headersFor(id: string, body: unknown) {
	let seen: Headers | undefined;
	const fetchStub = (async (_url: unknown, init?: RequestInit) => {
		seen = new Headers(init?.headers);
		return new Response(JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const registry = createModelRegistry(
		{
			anthropic: { apiKey: "a" },
			openai: { apiKey: "o" },
			google: { apiKey: "g" },
		},
		{ fetch: fetchStub },
	);
	await generateText({
		model: registry.languageModel(id as never),
		prompt: "hello",
	});
	return seen;
}

describe("createModelRegistry", () => {
	it("sends the anthropic key as x-api-key", async () => {
		const h = await headersFor("anthropic/claude-sonnet-5-5", bodies.anthropic);
		expect(h?.get("x-api-key")).toBe("a");
	});

	it("sends the openai key as a bearer token", async () => {
		const h = await headersFor("openai/gpt-5.5", bodies.openai);
		expect(h?.get("authorization")).toBe("Bearer o");
	});

	it("sends the google key as x-goog-api-key", async () => {
		const h = await headersFor("google/gemini-3.8-flash", bodies.google);
		expect(h?.get("x-goog-api-key")).toBe("g");
	});
});
