import type { ProposalPlan } from "../../src/improve/issues";

export function ProposalCard({ plan }: { plan: ProposalPlan }) {
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
		</article>
	);
}
