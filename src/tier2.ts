export interface Tier2Match {
	skillPath: string;
	reason: string;
}

export interface Tier2Context {
	filePaths: string[];
	additions: number;
	deletions: number;
	title: string;
	body: string | null;
	labels: string[];
	patchContent: string;
}

// ── Type Design Analyzer ────────────────────────────────────────────────────

const TYPED_EXTENSIONS = new Set([".ts", ".tsx", ".py", ".pyi"]);

const TYPE_PATCH_PATTERNS = [
	/\binterface\s+\w/,
	/\btype\s+\w+\s*=/,
	/\bclass\s+\w/,
	/\benum\s+\w/,
	/\bgeneric\b/i,
	/@dataclass/,
	/TypedDict/,
	/Protocol/,
	/\bUnion\[/,
	/\bOptional\[/,
	/\bGeneric\[/,
];

function shouldRunTypeDesign(ctx: Tier2Context): string | null {
	const hasTypedFiles = ctx.filePaths.some((p) => {
		const dot = p.lastIndexOf(".");
		return dot !== -1 && TYPED_EXTENSIONS.has(p.slice(dot));
	});
	if (!hasTypedFiles) return null;

	const hasTypeChanges = TYPE_PATCH_PATTERNS.some((re) =>
		re.test(ctx.patchContent),
	);
	if (!hasTypeChanges) return null;

	const typedFileCount = ctx.filePaths.filter((p) => {
		const dot = p.lastIndexOf(".");
		return dot !== -1 && TYPED_EXTENSIONS.has(p.slice(dot));
	}).length;

	return `${typedFileCount} typed file(s) changed with type definition modifications`;
}

// ── Comment Analyzer ─────────────────────────────────────────────────────────

const COMMENT_PATCH_PATTERNS = [
	/^\+.*\/\//m, // added JS/TS line comment
	/^\+.*#\s/m, // added Python/shell comment
	/^\+\s*\/\*/m, // added block comment open
	/^\+\s*\*/m, // added block comment continuation
	/^\+.*"""/m, // added Python docstring
	/^\+.*'''/m, // added Python docstring (single)
	/^\+\s*\*\s*@/m, // added JSDoc tag
];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);

function shouldRunCommentAnalyzer(ctx: Tier2Context): string | null {
	const hasDocFiles = ctx.filePaths.some((p) => {
		const dot = p.lastIndexOf(".");
		return dot !== -1 && DOC_EXTENSIONS.has(p.slice(dot));
	});
	if (hasDocFiles) {
		return "documentation files changed";
	}

	const commentLineCount = (ctx.patchContent.match(/^\+.*(?:\/\/|#\s|\*\s)/gm)
		?.length ?? 0);
	if (commentLineCount >= 5) {
		return `${commentLineCount} comment lines added or modified`;
	}

	const hasSignificantComments = COMMENT_PATCH_PATTERNS.some((re) =>
		re.test(ctx.patchContent),
	);
	if (hasSignificantComments && ctx.additions + ctx.deletions < 200) {
		return "substantial inline documentation changes detected";
	}

	return null;
}

// ── Security Auditor ─────────────────────────────────────────────────────────

const SECURITY_PATH_PATTERNS = [
	"auth",
	"login",
	"logout",
	"session",
	"token",
	"jwt",
	"oauth",
	"password",
	"credential",
	"secret",
	"payment",
	"billing",
	"stripe",
	"checkout",
	"invoice",
	"pii",
	"gdpr",
	"privacy",
	"user",
	"account",
	"permission",
	"role",
	"acl",
	"middleware",
	"guard",
	"policy",
	"infrastructure",
	"terraform",
	"docker",
	"k8s",
	"kubernetes",
	"helm",
	"deploy",
	"ci",
	".env",
];

const SECURITY_PATCH_PATTERNS = [
	/crypto\./i,
	/bcrypt/i,
	/hash(Password|Secret)/i,
	/verify(Token|Signature)/i,
	/Bearer\s/,
	/Authorization:/i,
	/access_token/i,
	/refresh_token/i,
	/process\.env\./,
];

function shouldRunSecurityAuditor(ctx: Tier2Context): string | null {
	const matchedPaths = ctx.filePaths.filter((p) => {
		const lower = p.toLowerCase();
		return SECURITY_PATH_PATTERNS.some((pattern) => lower.includes(pattern));
	});

	if (matchedPaths.length > 0) {
		const sample = matchedPaths.slice(0, 3).join(", ");
		return `security-sensitive paths changed: ${sample}`;
	}

	const titleAndBody = `${ctx.title} ${ctx.body ?? ""}`.toLowerCase();
	const sensitiveKeywords = [
		"auth",
		"security",
		"payment",
		"pii",
		"gdpr",
		"encrypt",
		"token",
		"credential",
	];
	const keywordMatches = sensitiveKeywords.filter((kw) =>
		titleAndBody.includes(kw),
	);
	if (keywordMatches.length >= 2) {
		return `PR title/description mentions security-sensitive terms: ${keywordMatches.join(", ")}`;
	}

	const hasSensitivePatch = SECURITY_PATCH_PATTERNS.some((re) =>
		re.test(ctx.patchContent),
	);
	if (hasSensitivePatch) {
		return "patch contains cryptography, token handling, or secrets-adjacent code";
	}

	return null;
}

// ── Architect Review ─────────────────────────────────────────────────────────

const ARCHITECT_PATH_PATTERNS = [
	"migration",
	"schema",
	"api/",
	"/api",
	"routes/",
	"router",
	"controller",
	"service/",
	"services/",
	"module/",
	"modules/",
	"config/",
	"infrastructure",
	"terraform",
	"docker-compose",
	"helm",
	"package.json",
	"pyproject.toml",
	"cargo.toml",
	"go.mod",
	"pubspec.yaml",
];

const LARGE_PR_THRESHOLD = 300;
const MANY_FILES_THRESHOLD = 10;

function shouldRunArchitectReview(ctx: Tier2Context): string | null {
	if (ctx.labels.includes("architecture") || ctx.labels.includes("breaking-change")) {
		return `PR labelled "${ctx.labels.find((l) => l === "architecture" || l === "breaking-change")}"`;
	}

	const matchedPaths = ctx.filePaths.filter((p) => {
		const lower = p.toLowerCase();
		return ARCHITECT_PATH_PATTERNS.some((pattern) => lower.includes(pattern));
	});

	if (matchedPaths.length >= 3) {
		return `${matchedPaths.length} architectural boundary files changed (routes, services, config, schema)`;
	}

	if (ctx.additions + ctx.deletions >= LARGE_PR_THRESHOLD && ctx.filePaths.length >= MANY_FILES_THRESHOLD) {
		return `large PR: ${ctx.additions + ctx.deletions} lines across ${ctx.filePaths.length} files`;
	}

	return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

const TIER2_DETECTORS: Array<{
	skillPath: string;
	detect: (ctx: Tier2Context) => string | null;
}> = [
	{ skillPath: "type-design-analyzer.md", detect: shouldRunTypeDesign },
	{ skillPath: "comment-analyzer.md", detect: shouldRunCommentAnalyzer },
	{ skillPath: "security-auditor.md", detect: shouldRunSecurityAuditor },
	{ skillPath: "architect-review.md", detect: shouldRunArchitectReview },
];

export function detectTier2Skills(ctx: Tier2Context): Tier2Match[] {
	const matches: Tier2Match[] = [];

	for (const { skillPath, detect } of TIER2_DETECTORS) {
		const reason = detect(ctx);
		if (reason !== null) {
			matches.push({ skillPath, reason });
		}
	}

	return matches;
}
