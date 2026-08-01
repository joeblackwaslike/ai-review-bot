export interface ReviewCommand {
	force: boolean;
	extraInstructions: string;
}

export function parseReviewCommand(
	body: string,
	commandName: string,
): ReviewCommand | null {
	const trimmed = body.trim();
	if (!trimmed.startsWith(commandName)) {
		return null;
	}

	const remainder = trimmed.slice(commandName.length).trim();
	if (!remainder) {
		return { force: false, extraInstructions: "" };
	}

	const parts = remainder.split(/\s+/);
	const extraParts: string[] = [];
	let force = false;

	for (const part of parts) {
		if (part === "--force") {
			force = true;
			continue;
		}
		extraParts.push(part);
	}

	return {
		force,
		extraInstructions: extraParts.join(" ").trim(),
	};
}

export function isTrustedAuthorAssociation(association: string): boolean {
	return ["OWNER", "MEMBER", "COLLABORATOR"].includes(association);
}

export interface QcCommand {
	/** Judge every posted finding rather than a sample. */
	full: boolean;
}

/** Parse a `/qc` comment. Returns null when the body is not the command, so a
 * comment merely *mentioning* /qc does not trigger a run. */
export function parseQcCommand(
	body: string,
	commandName: string,
): QcCommand | null {
	const trimmed = body.trim();
	if (trimmed !== commandName && !trimmed.startsWith(`${commandName} `)) {
		return null;
	}
	const remainder = trimmed.slice(commandName.length).trim();
	return { full: remainder === "--full" };
}
