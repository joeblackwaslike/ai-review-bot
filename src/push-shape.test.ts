import { describe, expect, it } from "vitest";
import type { PushFile } from "./moved-blocks.js";
import {
	classifyFile,
	classifyPush,
	type FileKind,
	shapedBudget,
} from "./push-shape.js";

function file(over: Partial<PushFile> & { filename: string }): PushFile {
	return {
		status: "modified",
		additions: 0,
		deletions: 0,
		patch: "@@ -1 +1 @@\n-a\n+b",
		...over,
	};
}

function addPatch(lines: string[]): string {
	return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
}

function delPatch(lines: string[]): string {
	return `@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}`;
}

describe("classifyFile", () => {
	const table: [string, FileKind][] = [
		["src/a.ts", "code"],
		["src/a.test.ts", "test"],
		["tests/x.ts", "test"],
		["README.md", "docs"],
		["docs/x.md", "docs"],
		["package.json", "config"],
		["tsconfig.json", "config"],
		[".github/dependabot.yml", "config"],
		["Dockerfile", "infra"],
		[".github/workflows/ci.yml", "infra"],
		["main.tf", "infra"],
		["scripts/run.sh", "shell"],
		["scripts/run.bash", "shell"],
		["scripts/run.zsh", "shell"],
		["requirements.txt", "config"],
		["constraints-dev.txt", "config"],
		["uv.lock", "lockfile"],
		["Gemfile.lock", "lockfile"],
		["composer.lock", "lockfile"],
		["pnpm-lock.yaml", "lockfile"],
		["logo.png", "binary"],
		["dist/app.min.js", "generated"],
	];
	for (const [name, kind] of table) {
		it(`${name} is ${kind}`, () => {
			expect(classifyFile(name)).toBe(kind);
		});
	}
});

describe("classifyPush", () => {
	const lines = (n: number, p = "line") =>
		Array.from({ length: n }, (_, i) => `${p} number ${i}`);

	it("weighs docs, code and lockfile changes by kind", () => {
		const w = (filename: string) =>
			classifyPush([
				file({ filename, additions: 20, patch: addPatch(lines(20)) }),
			]).reviewableWeight;
		expect(w("README.md")).toBeCloseTo(6);
		expect(w("src/a.ts")).toBe(20);
		expect(w("pnpm-lock.yaml")).toBe(0);
	});

	it("flags whitespace-only changes at weight 0", () => {
		const shape = classifyPush([
			file({
				filename: "src/a.ts",
				additions: 1,
				deletions: 1,
				patch: "@@ -1 +1 @@\n-const  a = 1;\n+const a =   1;",
			}),
		]);
		expect(shape.files[0]?.whitespaceOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(0);
	});

	describe("whitespace-only", () => {
		const ws = (filename: string, before: string, after: string) =>
			classifyPush([
				file({
					filename,
					additions: 1,
					deletions: 1,
					patch: `@@ -1 +1 @@\n-${before}\n+${after}`,
				}),
			]).files[0];

		it("keeps weight when a string literal's whitespace changes", () => {
			const f = ws(
				"src/a.ts",
				'const role = "read only";',
				'const role = "readonly";',
			);
			expect(f?.whitespaceOnly).toBe(false);
			expect(f?.weight).toBeGreaterThan(0);
		});

		it("keeps weight when a literal becomes empty", () => {
			expect(
				ws("src/a.ts", 'const separator = " ";', 'const separator = "";')
					?.whitespaceOnly,
			).toBe(false);
		});

		it("still ignores formatting outside literals", () => {
			expect(ws("src/a.ts", "const a=1;", "const a = 1;")?.whitespaceOnly).toBe(
				true,
			);
			expect(
				ws("src/a.ts", "    return 1;", "  return 1;")?.whitespaceOnly,
			).toBe(true);
		});

		it("keeps weight when a space between words is removed", () => {
			expect(
				ws("src/a.ts", "x = /foo bar/;", "x = /foobar/;")?.whitespaceOnly,
			).toBe(false);
		});

		it("ignores added blank lines and a reindent plus blank lines", () => {
			const blanks = (patch: string) =>
				classifyPush([
					file({ filename: "src/a.ts", additions: 3, deletions: 1, patch }),
				]).files[0]?.whitespaceOnly;
			expect(blanks("@@ -1 +1,2 @@\n a();\n+")).toBe(true);
			expect(blanks("@@ -1 +1,3 @@\n a();\n+\n+")).toBe(true);
			expect(blanks("@@ -1 +1,3 @@\n-  b();\n+b();\n+\n+")).toBe(true);
		});

		describe("per change run", () => {
			const patchOnly = (patch: string, filename = "src/a.ts") =>
				classifyPush([file({ filename, additions: 1, deletions: 1, patch })])
					.files[0]?.whitespaceOnly;

			it("keeps weight when a statement moves from an if branch to its else branch", () => {
				expect(
					patchOnly(
						[
							"@@ -1,5 +1,5 @@",
							" if (ok) {",
							"-  grantAccess();",
							" } else {",
							"+  grantAccess();",
							" }",
						].join("\n"),
					),
				).toBe(false);
			});

			it("keeps weight when a statement moves from before a write to after it", () => {
				expect(
					patchOnly(
						[
							"@@ -1,2 +1,2 @@",
							"-authorize(user);",
							" write(data);",
							"+authorize(user);",
						].join("\n"),
					),
				).toBe(false);
			});

			it("keeps weight when a statement moves across two hunks", () => {
				expect(
					patchOnly(
						[
							"@@ -1,2 +1,1 @@",
							"-authorize(user);",
							" first();",
							"@@ -40,1 +39,2 @@",
							" last();",
							"+authorize(user);",
						].join("\n"),
					),
				).toBe(false);
			});

			it("ignores a call wrapped onto several lines", () => {
				expect(
					patchOnly(
						[
							"@@ -1 +1,4 @@",
							"-foo(a, b);",
							"+foo(",
							"+  a,",
							"+  b",
							"+);",
						].join("\n"),
					),
				).toBe(true);
			});

			it("ignores a file where every run is a pure reindent", () => {
				expect(
					patchOnly(
						[
							"@@ -1,3 +1,3 @@",
							"-    a();",
							"+  a();",
							" keep();",
							"-    b();",
							"+  b();",
						].join("\n"),
					),
				).toBe(true);
			});

			it("keeps weight when one run of several is a real change", () => {
				expect(
					patchOnly(
						[
							"@@ -1,3 +1,3 @@",
							"-    a();",
							"+  a();",
							" keep();",
							"-    b();",
							"+  c();",
						].join("\n"),
					),
				).toBe(false);
			});
		});

		it("keeps weight when an increment moves across a plus operator", () => {
			expect(
				ws("src/a.ts", "const x = a + ++b;", "const x = a++ + b;")
					?.whitespaceOnly,
			).toBe(false);
		});

		it("treats a Python, YAML or Makefile reindent as a change", () => {
			expect(ws("src/a.py", "    return 1", "  return 1")?.whitespaceOnly).toBe(
				false,
			);
			expect(ws("ci/a.yml", "  key: 1", "    key: 1")?.whitespaceOnly).toBe(
				false,
			);
			expect(ws("Makefile", "\tgo build", "  go build")?.whitespaceOnly).toBe(
				false,
			);
		});

		it("still ignores spacing inside a Python line outside literals", () => {
			expect(ws("src/a.py", "x=1", "x = 1")?.whitespaceOnly).toBe(true);
		});
	});

	it("keeps weight for a Python block whose nesting changed, drops a pure move", () => {
		const py = ["if ready:", "x = 1", "y = 2", "z = 3", "w = 4"];
		const deeper = py.map((l) => `    ${l}`);
		const shape = (added: string[]) =>
			classifyPush([
				file({ filename: "a.py", deletions: 5, patch: delPatch(deeper) }),
				file({ filename: "b.py", additions: 5, patch: addPatch(added) }),
			]);
		expect(shape(py).reviewableWeight).toBeGreaterThan(0);
		expect(shape(deeper).reviewableWeight).toBe(0);
	});

	it("weighs a pure rename at 0", () => {
		const shape = classifyPush([
			file({
				filename: "src/b.ts",
				status: "renamed",
				previous_filename: "src/a.ts",
				patch: undefined,
			}),
		]);
		expect(shape.files[0]?.renameOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(0);
	});

	it("counts deletion-only files at kind weight times deleted lines", () => {
		const shape = classifyPush([
			file({ filename: "src/a.ts", deletions: 40, patch: delPatch(lines(40)) }),
		]);
		expect(shape.files[0]?.deletionOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(40);
	});

	it("subtracts moved lines from the destination's additions", () => {
		const block = lines(10, "moved statement");
		const shape = classifyPush([
			file({
				filename: "src/old.ts",
				deletions: 10,
				patch: delPatch(block),
			}),
			file({
				filename: "src/new.ts",
				additions: 20,
				patch: addPatch([...block, ...lines(10, "fresh")]),
			}),
		]);
		expect(shape.moved).toHaveLength(1);
		expect(shape.reviewableWeight).toBe(10);
	});

	it("weighs a pure move at 0 and keeps the source deletion-only", () => {
		const block = lines(10, "moved statement");
		const shape = classifyPush([
			file({ filename: "src/a.ts", deletions: 10, patch: delPatch(block) }),
			file({ filename: "src/b.ts", additions: 10, patch: addPatch(block) }),
		]);
		expect(shape.files[0]?.deletionOnly).toBe(true);
		expect(shape.reviewableWeight).toBe(0);
		expect(shapedBudget(shape, 10)).toBe(2);
	});

	it("weighs a 100-line pure move at 0", () => {
		const block = lines(100, "moved statement");
		const shape = classifyPush([
			file({ filename: "src/a.ts", deletions: 100, patch: delPatch(block) }),
			file({ filename: "src/b.ts", additions: 100, patch: addPatch(block) }),
		]);
		expect(shape.reviewableWeight).toBe(0);
	});

	it("weighs a 10-line move plus 20 fresh lines at 20", () => {
		const block = lines(10, "moved statement");
		const shape = classifyPush([
			file({ filename: "src/a.ts", deletions: 10, patch: delPatch(block) }),
			file({
				filename: "src/b.ts",
				additions: 30,
				patch: addPatch([...block, ...lines(20, "fresh")]),
			}),
		]);
		expect(shape.reviewableWeight).toBe(20);
	});

	it("treats a deleted --- line as a real change", () => {
		const shape = classifyPush([
			file({
				filename: "docs/a.md",
				additions: 1,
				deletions: 2,
				patch: "@@ -1,2 +1,1 @@\n-foo\n----\n+foo",
			}),
		]);
		expect(shape.files[0]?.whitespaceOnly).toBe(false);
	});

	it("separates file count from weight", () => {
		const many = classifyPush(
			Array.from({ length: 20 }, (_, i) =>
				file({
					filename: `src/f${i}.ts`,
					additions: 2,
					patch: addPatch(lines(2, `f${i}`)),
				}),
			),
		);
		const one = classifyPush([
			file({ filename: "src/x.ts", additions: 40, patch: addPatch(lines(40)) }),
		]);
		expect(many.reviewableWeight).toBe(40);
		expect(one.reviewableWeight).toBe(40);
		expect(many.fileCount).toBe(20);
		expect(one.fileCount).toBe(1);
	});

	it("weighs a patchless code file by its counts at its kind weight", () => {
		const shape = classifyPush([
			file({ filename: "src/big.ts", additions: 500, patch: undefined }),
		]);
		expect(shape.reviewableWeight).toBe(500);
		expect(shape.files[0].kind).toBe("code");
		expect(shapedBudget(shape, 10)).toBe(10);
	});

	it("weighs a patchless binary file at 0", () => {
		const shape = classifyPush([
			file({ filename: "logo.png", additions: 500, patch: undefined }),
		]);
		expect(shape.reviewableWeight).toBe(0);
	});

	it("weighs a patchless rename with no counts at 0 and marks it rename-only", () => {
		const shape = classifyPush([
			file({
				filename: "src/b.ts",
				status: "renamed",
				patch: undefined,
			}),
		]);
		expect(shape.reviewableWeight).toBe(0);
		expect(shape.files[0].renameOnly).toBe(true);
	});
});

describe("shapedBudget", () => {
	const budget = (weight: number, band: number) =>
		shapedBudget(
			{ files: [], reviewableWeight: weight, fileCount: 0, moved: [] },
			band,
		);
	it("clamps ceil(weight / 8) between 2 and the band", () => {
		expect(budget(0, 10)).toBe(2);
		expect(budget(40, 10)).toBe(5);
		expect(budget(400, 5)).toBe(5);
		expect(budget(3, 10)).toBe(2);
	});
});
