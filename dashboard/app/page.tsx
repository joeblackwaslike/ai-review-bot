import { loadDashboardData } from "../lib/trends-data";
import { ProposalCard } from "./ProposalCard";

export const runtime = "nodejs";

// Default export, not named -- Next.js App Router requires it for page.tsx's
// route component, overriding this repo's "no default exports" convention
// for this one file class (page.tsx/layout.tsx only).
export default async function DashboardPage() {
	const { outcomes, severity, duplicates, skills, proposals } =
		await loadDashboardData();

	return (
		<div>
			{/* One row per piece of feedback, not per unique finding -- a finding
			rated by several people appears once per rating (see the docstring on
			listFindingOutcomes). */}
			<p>Feedback records: {outcomes.length}</p>

			<section>
				<h2>Severity reliability</h2>
				<table>
					<thead>
						<tr>
							<th>Severity</th>
							<th>Useful</th>
							<th>Low value</th>
							<th>Wrong</th>
							<th>Sample</th>
							<th>Useful %</th>
						</tr>
					</thead>
					<tbody>
						{severity.map((s) => (
							<tr key={s.severity}>
								<td>{s.severity}</td>
								<td>{s.useful}</td>
								<td>{s.lowValue}</td>
								<td>{s.wrong}</td>
								<td>{s.sampleSize}</td>
								<td>{Math.round(s.usefulRatio * 100)}%</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section>
				<h2>Repeated claims ({duplicates.length} cluster(s))</h2>
				<ul>
					{duplicates.map((d) => (
						<li key={`${d.pr}:${d.path}:${d.identifier}`}>
							×{d.findingIds.length} #{d.pr} {d.path ?? "(no path)"} —{" "}
							<code>{d.identifier}</code>
							<ul>
								{d.titles.map((t, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: titles within a cluster can repeat verbatim; index disambiguates duplicates
									<li key={`${d.pr}:${d.identifier}:${i}`}>{t}</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			</section>

			<section>
				<h2>Skill signals</h2>
				<table>
					<thead>
						<tr>
							<th>Skill</th>
							<th>Useful</th>
							<th>Negative</th>
							<th>Sample</th>
							<th>Negative %</th>
						</tr>
					</thead>
					<tbody>
						{skills.map((s) => (
							<tr key={s.skill}>
								<td>{s.skill}</td>
								<td>{s.useful}</td>
								<td>{s.negative}</td>
								<td>{s.sampleSize}</td>
								<td>{Math.round(s.negativeRatio * 100)}%</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section>
				<h2>Proposals</h2>
				{proposals.length === 0 ? (
					<p>No signal above threshold.</p>
				) : (
					proposals.map((p) => <ProposalCard key={p.signature} plan={p} />)
				)}
			</section>
		</div>
	);
}
