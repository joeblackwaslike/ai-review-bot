import { App } from "octokit";
import { isTrustedAuthorAssociation, parseQcCommand } from "./commands.js";
import { getQcAppConfig, type QcAppConfig } from "./config.js";
import { getDb } from "./improve/db/client.js";
import { listFindingsForPr, recordQcRun } from "./improve/db/repo.js";
import {
	formatQcComment,
	type JudgeableFinding,
	judgeFinding,
	selectQcSample,
	summarize,
} from "./improve/qc.js";

let qcAppSingleton: App | null = null;

export function getQcApp(): App {
	if (qcAppSingleton) return qcAppSingleton;
	const config = getQcAppConfig();
	qcAppSingleton = new App({
		appId: config.appId,
		privateKey: config.privateKey,
		webhooks: { secret: config.webhookSecret },
	});
	registerQcHandlers(qcAppSingleton, config);
	return qcAppSingleton;
}

interface IssueCommentPayload {
	action: string;
	installation?: { id: number };
	issue: { number: number; pull_request?: { url: string } };
	comment: { body: string; author_association: string };
	repository: { name: string; owner: { login: string } };
}

function registerQcHandlers(app: App, config: QcAppConfig): void {
	app.webhooks.on("issue_comment.created", async ({ payload }) => {
		const p = payload as unknown as IssueCommentPayload;
		if (!p.issue.pull_request) return;

		const command = parseQcCommand(p.comment.body, config.command);
		if (!command) return;

		// Same gate as the review command: judging is model spend, and an
		// untrusted commenter must not be able to trigger it.
		if (!isTrustedAuthorAssociation(p.comment.author_association)) {
			console.log("qc skipped: untrusted author association", {
				association: p.comment.author_association,
			});
			return;
		}
		if (!config.enabled) {
			console.log("qc skipped: IMPROVE_QC_ENABLED is false");
			return;
		}

		const installationId = p.installation?.id;
		if (!installationId) return;

		await runPrQc({
			app,
			config,
			installationId,
			owner: p.repository.owner.login,
			repo: p.repository.name,
			pr: p.issue.number,
			trigger: "command",
			full: command.full,
		});
	});
}

/** Judge the findings already posted on a PR and report once.
 *
 * Reads findings from the corpus rather than re-running the review agents —
 * this audits what was actually said, and re-running would produce a different
 * set of findings to judge, which is a different question. */
export async function runPrQc(deps: {
	app: App;
	config: QcAppConfig;
	installationId: number;
	owner: string;
	repo: string;
	pr: number;
	trigger: "command" | "sample";
	full?: boolean;
	rng?: () => number;
}): Promise<{ judged: number; posted: boolean; reason?: string }> {
	const { owner, repo, pr } = deps;
	const db = getDb();
	const octokit = await deps.app.getInstallationOctokit(deps.installationId);

	const { data: pull } = await octokit.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ owner, repo, pull_number: pr },
	);
	const headSha = (pull as { head: { sha: string } }).head.sha;

	// One report per PR head. A second /qc on an unchanged PR would spend model
	// budget re-deriving a verdict nobody asked to change.
	const claimed = await recordQcRun(db, {
		owner,
		repo,
		pr,
		trigger: deps.trigger,
		findingsJudged: 0,
		falsePositives: 0,
		dedupKey: `qcrun:${owner}/${repo}#${pr}:${headSha}`,
	});
	if (claimed === 0) {
		console.log("qc skipped: already reported for this head", { pr, headSha });
		return { judged: 0, posted: false, reason: "already-reported" };
	}

	const findings = (await listFindingsForPr(db, owner, repo, pr)).map(
		(f): JudgeableFinding => ({
			id: f.id,
			provider: f.provider,
			path: f.path,
			line: f.line,
			title: f.title,
			severity: f.severity,
			body: f.title,
		}),
	);

	const selected = deps.full
		? findings
		: selectQcSample(findings, deps.config.sampleRate, deps.rng ?? Math.random);

	const results = [];
	for (const finding of selected) {
		results.push({ finding, verdict: await judgeFinding(finding, "") });
	}
	const report = summarize(results);

	await octokit.request(
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		{
			owner,
			repo,
			issue_number: pr,
			body: formatQcComment(deps.config.commentPrefix, report),
		},
	);

	console.log("qc reported", {
		owner,
		repo,
		pr,
		judged: report.judged,
		falsePositives: report.falsePositives,
	});
	return { judged: report.judged, posted: true };
}
