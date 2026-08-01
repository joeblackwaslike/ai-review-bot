import { App, type Octokit } from "octokit";
import { isTrustedAuthorAssociation, parseQcCommand } from "./commands.js";
import { getQcAppConfig, type QcAppConfig } from "./config.js";
import { getDb } from "./improve/db/client.js";
import {
	finalizeQcRun,
	listFindingsForPr,
	reclaimStaleQcRun,
	recordQcRun,
	releaseQcRun,
} from "./improve/db/repo.js";
import { parseFindingComment } from "./improve/findings.js";
import {
	formatQcComment,
	type JudgeableFinding,
	judgeFinding,
	selectQcSample,
	summarize,
} from "./improve/qc.js";

/** How long a claim can go unfinished before another /qc may take it over.
 * Matches the QC function's `maxDuration` in vercel.json: past that the
 * instance is gone, so nothing can still be working under that claim. */
const QC_CLAIM_TTL_S = 300;

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
	// budget re-deriving a verdict nobody asked to change. Claimed before any
	// work — the counts below are placeholders that finalizeQcRun overwrites —
	// so two concurrent commands cannot both start; the catch below releases it
	// again if this run never gets as far as posting.
	const dedupKey = `qcrun:${owner}/${repo}#${pr}:${headSha}`;
	const claim = () =>
		recordQcRun(db, {
			owner,
			repo,
			pr,
			trigger: deps.trigger,
			findingsJudged: 0,
			falsePositives: 0,
			dedupKey,
		});

	let claimed = await claim();
	if (
		claimed === 0 &&
		(await reclaimStaleQcRun(db, dedupKey, QC_CLAIM_TTL_S))
	) {
		console.log("qc: reclaiming a run that died without reporting", { pr });
		claimed = await claim();
	}
	if (claimed === 0) {
		console.log("qc skipped: already reported for this head", { pr, headSha });
		return { judged: 0, posted: false, reason: "already-reported" };
	}

	try {
		const catalog = await listFindingsForPr(db, owner, repo, pr);
		const selected = deps.full
			? catalog
			: selectQcSample(
					catalog,
					deps.config.sampleRate,
					deps.rng ?? Math.random,
				);

		const results = [];
		for (const row of selected) {
			const { body, hunk } = await loadFindingContext(
				octokit,
				owner,
				repo,
				pr,
				row,
			);
			const finding: JudgeableFinding = {
				id: row.id,
				provider: row.provider,
				path: row.path,
				line: row.line,
				title: row.title,
				severity: row.severity,
				body,
			};
			results.push({ finding, verdict: await judgeFinding(finding, hunk) });
		}
		const report = summarize(results);

		const { data: comment } = await octokit.request(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{
				owner,
				repo,
				issue_number: pr,
				body: formatQcComment(deps.config.commentPrefix, report),
			},
		);

		// Deliberately not inside the try above. Once the report is posted the run
		// has succeeded; letting a failure here reach the catch would release the
		// claim on a head that already has a report, and the next /qc would post a
		// second one. The row keeps its placeholder counts instead, which is a
		// bookkeeping loss rather than a duplicate comment.
		await finalizeQcRun(db, dedupKey, {
			findingsJudged: report.judged,
			falsePositives: report.falsePositives,
			prCommentId: comment.id,
		}).catch((finalizeErr) => {
			console.error("qc: report posted but counts were not recorded", {
				dedupKey,
				prCommentId: comment.id,
				finalizeErr,
			});
		});

		console.log("qc reported", {
			owner,
			repo,
			pr,
			judged: report.judged,
			falsePositives: report.falsePositives,
		});
		return { judged: report.judged, posted: true };
	} catch (err) {
		// The claim is taken up front so two concurrent /qc runs cannot both spend
		// model budget on the same head. Holding it after a failure would turn one
		// transient error into a permanent lockout: every later /qc on this head
		// returns "already-reported" and no report is ever posted.
		await releaseQcRun(db, dedupKey).catch((releaseErr) => {
			console.error("qc: failed to release claim after error", {
				dedupKey,
				releaseErr,
			});
		});
		throw err;
	}
}

/** A comment that is genuinely gone, as opposed to one we failed to read.
 *
 * Only these degrade to empty context. An auth failure, a rate limit or a
 * GitHub outage would otherwise be indistinguishable from deletion, and would
 * silently judge every finding in the run with no body and no code — verdicts
 * that look complete and mean nothing. */
function isCommentGone(err: unknown): boolean {
	const status = (err as { status?: number } | null)?.status;
	return status === 404 || status === 410;
}

/** The finding's own words and the code it was anchored to.
 *
 * `finding_catalog` stores the title only — the posted comment is the source of
 * truth for the rest, and duplicating it into the table would let the two
 * drift. Reading it back also yields `diff_hunk`, without which the judge is
 * asked whether a claim about code holds while being shown no code.
 *
 * Every catalogued comment id is a pull-request review comment: general
 * findings have no comment at all and are stored with a null id. */
async function loadFindingContext(
	octokit: Octokit,
	owner: string,
	repo: string,
	pr: number,
	row: { id: number; commentId: number | null },
): Promise<{ body: string; hunk: string }> {
	if (row.commentId === null) return { body: "", hunk: "" };
	try {
		const { data } = await octokit.request(
			"GET /repos/{owner}/{repo}/pulls/comments/{comment_id}",
			{ owner, repo, comment_id: row.commentId },
		);
		const parsed = parseFindingComment(data.body);
		// An empty parsed body is the honest answer, not a parse failure: the
		// comment carried a title and nothing else. Falling back to the raw text
		// there would hand the judge the title twice, which is the bug this
		// function exists to remove.
		return {
			body: parsed ? parsed.body : data.body,
			hunk: data.diff_hunk ?? "",
		};
	} catch (err) {
		if (!isCommentGone(err)) throw err;
		console.error("qc: finding comment is gone; judging without it", {
			owner,
			repo,
			pr,
			findingId: row.id,
			commentId: row.commentId,
			err,
		});
		return { body: "", hunk: "" };
	}
}
