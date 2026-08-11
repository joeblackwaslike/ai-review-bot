"use client";

import { useState, useTransition } from "react";
import type { ProposalPlan } from "../../src/improve/issues";
import { type OpenIssueResult, openIssueFromProposal } from "./actions";

export function ProposalCard({ plan }: { plan: ProposalPlan }) {
	const [isPending, startTransition] = useTransition();
	const [result, setResult] = useState<OpenIssueResult | null>(null);

	function handleClick() {
		startTransition(async () => {
			setResult(await openIssueFromProposal(plan));
		});
	}

	return (
		<article
			style={{
				border: "1px solid #ccc",
				padding: "1rem",
				marginBottom: "1rem",
			}}
		>
			<h3>{plan.title}</h3>
			<p>
				<strong>Kind:</strong> {plan.kind} · <strong>Target:</strong>{" "}
				<code>{plan.targetFile}</code>
			</p>
			<pre style={{ whiteSpace: "pre-wrap" }}>{plan.body}</pre>
			<button type="button" onClick={handleClick} disabled={isPending}>
				{isPending ? "Opening…" : "Open issue from metric"}
			</button>
			{result && (
				<p>
					{result.action === "failed"
						? `Failed: ${result.error ?? "unknown error"}`
						: `${result.action}${result.url ? ` — ${result.url}` : ""}`}
				</p>
			)}
		</article>
	);
}
