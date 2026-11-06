import { isGeneratedFile } from "./diff-pack.js";
import {
	findMovedBlocks,
	isIndentSensitive,
	type MovedBlock,
	needsSeparator,
	normalizeCodeLine,
	type PushFile,
} from "./moved-blocks.js";

export type FileKind =
	| "code"
	| "test"
	| "docs"
	| "config"
	| "infra"
	| "shell"
	| "binary"
	| "generated"
	| "lockfile";

/** What one file of a push contributes to its reviewable weight. */
export interface FileShape {
	filename: string;
	kind: FileKind;
	weight: number;
	whitespaceOnly: boolean;
	renameOnly: boolean;
	deletionOnly: boolean;
}

/** What a push changed, reduced to a reviewable weight. */
export interface PushShape {
	files: FileShape[];
	reviewableWeight: number;
	fileCount: number;
	moved: MovedBlock[];
}

const KIND_WEIGHT: Record<FileKind, number> = {
	code: 1,
	shell: 1,
	test: 0.7,
	config: 0.5,
	infra: 0.5,
	docs: 0.3,
	generated: 0,
	lockfile: 0,
	binary: 0,
};

const LOCKFILES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"Cargo.lock",
	"poetry.lock",
	"go.sum",
	"uv.lock",
	"Gemfile.lock",
	"composer.lock",
]);
const BINARY_EXT =
	/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp[34]|mov|wasm)$/i;
const PIN_FILE = /^(requirements|constraints)[^/]*\.txt$/i;
const DOCS_EXT = /\.(md|mdx|rst|txt)$/i;
const CONFIG_EXT = /\.(json|jsonc|ya?ml|toml|ini|env)$/i;
const INFRA_EXT = /\.(tf|tfvars|hcl)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/;

/** Sorts a path into the kind that sets how much of its change is worth reviewing. A file
 * GitHub sent without a patch is still classified by its path, so only a binary extension
 * makes it weightless. */
export function classifyFile(filename: string): FileKind {
	const name = filename.split("/").pop() ?? filename;
	if (LOCKFILES.has(name)) return "lockfile";
	if (isGeneratedFile(filename)) return "generated";
	if (BINARY_EXT.test(name)) return "binary";
	if (PIN_FILE.test(name)) return "config";
	if (TEST_PATH.test(filename)) return "test";
	if (
		name === "Dockerfile" ||
		name.startsWith("Dockerfile.") ||
		filename.startsWith(".github/workflows/") ||
		INFRA_EXT.test(name)
	) {
		return "infra";
	}
	if (/\.(sh|bash|zsh)$/.test(name)) return "shell";
	if (DOCS_EXT.test(name) || filename.startsWith("docs/")) return "docs";
	if (CONFIG_EXT.test(name)) return "config";
	return "code";
}

function joinRun(lines: string[]): string {
	let out = "";
	for (const line of lines) {
		if (line.trim() === "") continue;
		if (out !== "" && needsSeparator(out, line[0] as string)) out += " ";
		out += line;
	}
	return out;
}

function isWhitespaceOnly(
	filename: string,
	patch: string | undefined,
): boolean {
	if (!patch) return false;
	const opts = isIndentSensitive(filename)
		? { strip: true, keepIndent: true }
		: { strip: true };
	let removed: string[] = [];
	let added: string[] = [];
	let runs = 0;
	const closeRun = (): boolean => {
		if (removed.length + added.length === 0) return true;
		runs++;
		const same = joinRun(removed) === joinRun(added);
		removed = [];
		added = [];
		return same;
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("\\")) continue;
		if (line.startsWith("-"))
			removed.push(normalizeCodeLine(line.slice(1), opts));
		else if (line.startsWith("+"))
			added.push(normalizeCodeLine(line.slice(1), opts));
		else if (!closeRun()) return false;
	}
	return closeRun() && runs > 0;
}

function shapeFile(
	file: PushFile,
	movedIn: number,
	movedOut: number,
): FileShape {
	const kind = classifyFile(file.filename);
	const renameOnly =
		file.status === "renamed" && file.additions === 0 && file.deletions === 0;
	const whitespaceOnly = isWhitespaceOnly(file.filename, file.patch);
	const deletionOnly = file.additions === 0 && file.deletions > 0;
	const changed =
		Math.max(file.additions - movedIn, 0) +
		Math.max(file.deletions - movedOut, 0);
	const weight = renameOnly || whitespaceOnly ? 0 : KIND_WEIGHT[kind] * changed;
	return {
		filename: file.filename,
		kind,
		weight,
		whitespaceOnly,
		renameOnly,
		deletionOnly,
	};
}

/** Reads what a push changed: file kinds, whitespace-only, renames, deletions and moved code. */
export function classifyPush(files: PushFile[]): PushShape {
	const moved = findMovedBlocks(files);
	const movedIn = new Map<string, number>();
	for (const block of moved) {
		movedIn.set(block.to, (movedIn.get(block.to) ?? 0) + block.lineCount);
	}
	const movedOut = new Map<string, number>();
	for (const block of moved) {
		movedOut.set(block.from, (movedOut.get(block.from) ?? 0) + block.lineCount);
	}
	const shaped = files.map((f) =>
		shapeFile(f, movedIn.get(f.filename) ?? 0, movedOut.get(f.filename) ?? 0),
	);
	return {
		files: shaped,
		reviewableWeight: shaped.reduce((sum, f) => sum + f.weight, 0),
		fileCount: files.length,
		moved,
	};
}

/** Review-round budget for a push: one unit per 8 weight, at least 2, at most the band's. */
export function shapedBudget(shape: PushShape, bandBudget: number): number {
	const wanted = Math.ceil(shape.reviewableWeight / 8);
	return Math.min(Math.max(wanted, 2), bandBudget);
}
