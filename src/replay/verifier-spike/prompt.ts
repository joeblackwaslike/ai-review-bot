import { createHash } from "node:crypto";
import { z } from "zod";
import { REFUTATION_REASONS } from "./types.js";

export const MAX_FILE_CHARS = 60_000;

/**
 * The verdict comes first so the model commits before it explains. A refutation must name its
 * reason and a verified finding must not. The spec's fifth reason, "contradicts a settled ledger
 * entry", is left out because the spike gives the verifier no ledger.
 */
export const VerifierSchema = z
	.object({
		refuted: z.boolean(),
		reason: z.enum(REFUTATION_REASONS).nullable(),
		rationale: z.string(),
	})
	.refine((v) => v.refuted === (v.reason !== null), {
		message:
			"a refutation needs a reason and a verified finding must not have one",
	});

export const PROMPT_TEMPLATE = [
	"You are checking one code review finding against the current version of the file it is about.",
	"Try to refute it. Refute only when the file gives you counter-evidence you can point to: the problem it describes cannot happen, the claimed root cause is wrong, it is a matter of style only, or it is a generic 'missing X' with nothing specific broken.",
	"If you cannot point to counter-evidence in the file, do not refute it, even if you doubt it.",
	"Answer refuted true or false first. When refuted is true give the reason; when false give none. Then give a rationale in one or two sentences that cites the lines you relied on.",
].join("\n");

export interface VerifierInput {
	title: string;
	path: string | null;
	line: number | null;
	text: string;
	fileText: string;
}

export function numberLines(text: string): string {
	return text
		.split("\n")
		.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
		.join("\n");
}

function renderFile(fileText: string, maxFileChars: number): string {
	if (fileText.length <= maxFileChars) return numberLines(fileText);
	return `${numberLines(fileText.slice(0, maxFileChars))}\n[file truncated: ${maxFileChars} of ${fileText.length} characters shown]`;
}

export function buildVerifierPrompt(
	input: VerifierInput,
	options: { template?: string; maxFileChars?: number } = {},
): string {
	return [
		options.template ?? PROMPT_TEMPLATE,
		`Finding: ${input.title}`,
		`Location: ${input.path ?? "(none)"}:${input.line ?? "?"}`,
		`Finding text:\n${input.text}`,
		`File:\n${renderFile(input.fileText, options.maxFileChars ?? MAX_FILE_CHARS)}`,
	].join("\n\n");
}

/** Hash of everything that shapes a verdict, so a changed prompt or schema never reuses cached verdicts. */
export function computeVerifierPromptHash(
	inputs: { template?: string } = {},
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				prompt: buildVerifierPrompt(
					{
						title: "t",
						path: "p",
						line: 1,
						text: "x",
						fileText: "y",
					},
					{ template: inputs.template },
				),
				maxFileChars: MAX_FILE_CHARS,
				schema: z.toJSONSchema(VerifierSchema),
			}),
		)
		.digest("hex");
}

export const VERIFIER_PROMPT_HASH = computeVerifierPromptHash();
