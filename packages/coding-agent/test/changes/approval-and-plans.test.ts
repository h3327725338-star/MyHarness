import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	assessChangeRisk,
	describeChangeset,
	MAX_AUTO_APPROVED_FILES,
	MAX_AUTO_APPROVED_LINES,
} from "../../src/changes/approval.ts";
import { buildChangeset, type Changeset } from "../../src/changes/changeset.ts";
import { ChangeControlError } from "../../src/changes/errors.ts";
import { MAX_PATCH_FILES, planPatch } from "../../src/changes/patch-plan.ts";
import { verifyRenameEdits } from "../../src/changes/rename-check.ts";
import { decodeWorkspaceEdit } from "../../src/changes/workspace-edit.ts";
import { createTestWorkspace, disposeTestWorkspaces, modification } from "./helpers.ts";

afterEach(disposeTestWorkspaces);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ChangeControlError ? error.code : `other:${String(error)}`;
	}
	return undefined;
}

async function changesetOf(files: Record<string, string>, after: (path: string) => string): Promise<Changeset> {
	const workspace = createTestWorkspace(files);
	return buildChangeset({
		workspaceRoot: workspace.root,
		description: "test",
		source: "patch",
		modified: await Promise.all(Object.keys(files).map((path) => modification(workspace, path, after(path)))),
	}).changeset;
}

describe("assessChangeRisk", () => {
	it("calls a modest change inside ordinary source files low risk", async () => {
		const changeset = await changesetOf({ "src/a.ts": "a\n", "src/b.ts": "b\n" }, (path) => `${path} changed\n`);

		expect(assessChangeRisk(changeset)).toEqual({ level: "low", reasons: [] });
	});

	it("needs the user for a change over many files or many lines", async () => {
		const files = Object.fromEntries(
			Array.from({ length: MAX_AUTO_APPROVED_FILES + 1 }, (_, index) => [`src/f${index}.ts`, "x\n"]),
		);
		const wide = await changesetOf(files, () => "y\n");
		expect(assessChangeRisk(wide).level).toBe("needs_user");
		expect(assessChangeRisk(wide).reasons.join(" ")).toContain(`more than ${MAX_AUTO_APPROVED_FILES}`);

		const long = await changesetOf({ "src/big.ts": "x\n" }, () => "line\n".repeat(MAX_AUTO_APPROVED_LINES + 1));
		expect(assessChangeRisk(long).reasons.join(" ")).toContain("lines");
	});

	it.each([
		["package-lock.json", "dependency lock file"],
		["pnpm-lock.yaml", "dependency lock file"],
		[".github/workflows/ci.yml", "CI workflow"],
		[".myharness/settings.json", "project configuration"],
		["node_modules/pkg/index.js", "node_modules"],
		[".env.local", "environment file"],
		[".npmrc", "credentials"],
	])("needs the user for %s", async (path, reason) => {
		const changeset = await changesetOf({ [path]: "a\n" }, () => "b\n");

		const risk = assessChangeRisk(changeset);

		expect(risk.level).toBe("needs_user");
		expect(risk.reasons.join(" ")).toContain(reason);
	});

	it("needs the user when the server asks for confirmation of an annotated change", async () => {
		const changeset = {
			...(await changesetOf({ "src/a.ts": "a\n" }, () => "b\n")),
			needsConfirmation: ["Rename in strings"],
		};

		expect(assessChangeRisk(changeset).reasons.join(" ")).toContain("Rename in strings");
	});

	it("describes a change with its files and line counts", async () => {
		const changeset = await changesetOf({ "src/a.ts": "a\n" }, () => "b\nc\n");

		expect(describeChangeset(changeset)).toContain("~ src/a.ts  (+2 -1)");
	});
});

describe("verifyRenameEdits", () => {
	async function decoded(files: Record<string, string>, edits: Record<string, Array<[number, number, string]>>) {
		const workspace = createTestWorkspace(files);
		const changes = Object.fromEntries(
			Object.entries(edits).map(([path, list]) => [
				pathToFileURL(workspace.abs(path)).href,
				list.map(([from, to, newText]) => ({
					range: { start: { line: 0, character: from }, end: { line: 0, character: to } },
					newText,
				})),
			]),
		);
		return decodeWorkspaceEdit({ changes }, { workspaceRoot: workspace.root });
	}

	it("accepts an edit whose every range holds the old name", async () => {
		const edit = await decoded(
			{ "src/a.ts": "export class Alpha {}\n", "src/b.ts": "import { Alpha } from './a';\n" },
			{ "src/a.ts": [[13, 18, "Beta"]], "src/b.ts": [[9, 14, "Beta"]] },
		);

		expect(verifyRenameEdits(edit.files, "Alpha")).toEqual({ replacements: 2 });
	});

	it("refuses an edit that replaces other text, as a server working from older files would", async () => {
		const edit = await decoded(
			{ "src/a.ts": "export class Alpha {}\n", "src/b.ts": "import { Alpha } from './a';\n" },
			{ "src/a.ts": [[13, 18, "Beta"]], "src/b.ts": [[10, 15, "Beta"]] },
		);

		const error = (await Promise.resolve()
			.then(() => verifyRenameEdits(edit.files, "Alpha"))
			.catch((e: unknown) => e)) as ChangeControlError | undefined;

		expect(error).toBeInstanceOf(ChangeControlError);
		expect(error?.code).toBe("SNAPSHOT_STALE");
		expect(error?.message).toContain("src/b.ts");
		expect(error?.paths).toContain("src/b.ts");
	});

	it("refuses a rename that changes nothing", () => {
		expect(() => verifyRenameEdits([], "Alpha")).toThrowError(/changes nothing/u);
	});
});

describe("planPatch", () => {
	it("applies exact edits to several files and creates a new one, keeping BOM and line endings", async () => {
		const workspace = createTestWorkspace({
			"src/a.ts": "export const a = 1;\r\nexport const b = 2;\r\n",
			"src/bom.ts": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const x = 1;\n")]),
		});

		const built = await planPatch(
			[
				{ path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 10" }] },
				{ path: "src/bom.ts", edits: [{ oldText: "x = 1", newText: "x = 2" }] },
				{ path: "src/new.ts", content: "export const n = 1;\n" },
			],
			{ workspaceRoot: workspace.root, description: "patch" },
		);

		const byPath = new Map(built.changeset.files.map((file) => [file.path, file]));
		expect([...byPath.keys()]).toEqual(["src/a.ts", "src/bom.ts", "src/new.ts"]);
		expect(byPath.get("src/new.ts")?.operation).toBe("create");
		expect(built.content.after.get("src/a.ts")?.toString("utf8")).toBe(
			"export const a = 10;\r\nexport const b = 2;\r\n",
		);
		const bom = built.content.after.get("src/bom.ts");
		expect([...(bom?.subarray(0, 3) ?? [])]).toEqual([0xef, 0xbb, 0xbf]);
		expect(bom?.subarray(3).toString("utf8")).toBe("const x = 2;\n");
	});

	it("refuses an edit whose text is missing or not unique, naming the file", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\nx\n" });

		const missing = await codeOf(
			planPatch([{ path: "src/a.ts", edits: [{ oldText: "nope", newText: "y" }] }], {
				workspaceRoot: workspace.root,
				description: "d",
			}),
		);
		const duplicate = await codeOf(
			planPatch([{ path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }], {
				workspaceRoot: workspace.root,
				description: "d",
			}),
		);

		expect(missing).toBe("INVALID_EDIT");
		expect(duplicate).toBe("INVALID_EDIT");
	});

	it("refuses to create a file that exists, to edit one that does not, and to change a file twice", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\n" });
		const options = { workspaceRoot: workspace.root, description: "d" };

		expect(await codeOf(planPatch([{ path: "src/a.ts", content: "y\n" }], options))).toBe("EDIT_CONFLICT");
		expect(await codeOf(planPatch([{ path: "src/none.ts", edits: [{ oldText: "a", newText: "b" }] }], options))).toBe(
			"INVALID_EDIT",
		);
		expect(
			await codeOf(
				planPatch(
					[
						{ path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] },
						{ path: "SRC/A.ts", edits: [{ oldText: "x", newText: "z" }] },
					],
					options,
				),
			),
		).toBe("INVALID_EDIT");
	});

	it("refuses files with mixed line endings, which a patch could not keep intact", async () => {
		const workspace = createTestWorkspace({ "src/mixed.ts": "a\r\nb\nc\r\n" });

		const code = await codeOf(
			planPatch([{ path: "src/mixed.ts", edits: [{ oldText: "b", newText: "x" }] }], {
				workspaceRoot: workspace.root,
				description: "d",
			}),
		);

		expect(code).toBe("UNSUPPORTED_FILE");
	});

	it("refuses paths outside the workspace and version-control metadata", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\n", ".git/config": "[core]\n" });
		const options = { workspaceRoot: workspace.root, description: "d" };

		expect(await codeOf(planPatch([{ path: "../outside.ts", content: "x\n" }], options))).toBe("PATH_OUT_OF_SCOPE");
		expect(
			await codeOf(planPatch([{ path: ".git/config", edits: [{ oldText: "core", newText: "x" }] }], options)),
		).toBe("PATH_OUT_OF_SCOPE");
		expect(await codeOf(planPatch([{ path: ".GIT/hooks/pre-commit", content: "#!/bin/sh\n" }], options))).toBe(
			"PATH_OUT_OF_SCOPE",
		);
	});

	it("refuses an empty patch and one that is too wide", async () => {
		const workspace = createTestWorkspace({});
		const options = { workspaceRoot: workspace.root, description: "d" };

		expect(await codeOf(planPatch([], options))).toBe("INVALID_EDIT");
		const wide = Array.from({ length: MAX_PATCH_FILES + 1 }, (_, index) => ({
			path: `src/f${index}.ts`,
			content: "x\n",
		}));
		expect(await codeOf(planPatch(wide, options))).toBe("INVALID_EDIT");
	});
});
