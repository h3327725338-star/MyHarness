import { afterEach, describe, expect, it } from "vitest";
import { ChangeControlError } from "../../src/changes/errors.ts";
import { decodeWorkspaceEdit } from "../../src/changes/workspace-edit.ts";
import { toFileUri } from "../../src/symbols/path-semantics.ts";
import { createTestWorkspace, disposeTestWorkspaces, type TestWorkspace } from "./helpers.ts";

afterEach(disposeTestWorkspaces);

function textEdit(line: number, start: number, end: number, newText: string) {
	return { range: { start: { line, character: start }, end: { line, character: end } }, newText };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ChangeControlError ? error.code : `other:${String(error)}`;
	}
	return undefined;
}

function uri(workspace: TestWorkspace, path: string): string {
	return toFileUri(workspace.abs(path));
}

describe("decodeWorkspaceEdit", () => {
	it("resolves changes across files against the text on disk and records the base hash", async () => {
		const workspace = createTestWorkspace({
			"src/a.ts": "export function oldName() {}\n",
			"src/b.ts": "import { oldName } from './a';\noldName();\n",
		});

		const decoded = await decodeWorkspaceEdit(
			{
				changes: {
					[uri(workspace, "src/a.ts")]: [textEdit(0, 16, 23, "newName")],
					[uri(workspace, "src/b.ts")]: [textEdit(0, 9, 16, "newName"), textEdit(1, 0, 7, "newName")],
				},
			},
			{ workspaceRoot: workspace.root },
		);

		expect(decoded.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(decoded.files[0].afterText).toBe("export function newName() {}\n");
		expect(decoded.files[1].afterText).toBe("import { newName } from './a';\nnewName();\n");
		expect(decoded.files[0].edits[0].oldText).toBe("oldName");
		expect(decoded.files[0].baseHash).toMatch(/^[0-9a-f]{64}$/);
		expect(decoded.needsConfirmation).toEqual([]);
	});

	it("merges edits that reach one file through two spellings of its URI", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "one two\n" });
		// Servers and editors spell the same file differently: lower-case drive, encoded colon.
		const alternate = uri(workspace, "src/a.ts").replace(
			/^file:\/\/\/([A-Za-z]):/,
			(_match, drive: string) => `file:///${drive.toLowerCase()}%3A`,
		);

		const decoded = await decodeWorkspaceEdit(
			{
				documentChanges: [
					{ textDocument: { uri: uri(workspace, "src/a.ts"), version: null }, edits: [textEdit(0, 0, 3, "1")] },
					{ textDocument: { uri: alternate, version: null }, edits: [textEdit(0, 4, 7, "2")] },
				],
			},
			{ workspaceRoot: workspace.root },
		);

		expect(decoded.files).toHaveLength(1);
		expect(decoded.files[0].afterText).toBe("1 2\n");
	});

	it("keeps same-point inserts in array order across the whole edit", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "ab\n" });

		const decoded = await decodeWorkspaceEdit(
			{ changes: { [uri(workspace, "src/a.ts")]: [textEdit(0, 1, 1, "X"), textEdit(0, 1, 1, "Y")] } },
			{ workspaceRoot: workspace.root },
		);

		expect(decoded.files[0].afterText).toBe("aXYb\n");
	});

	it("refuses file operations instead of approximating them, so the client can leave them unadvertised", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\n" });

		for (const operation of [
			{ kind: "create", uri: uri(workspace, "src/new.ts") },
			{ kind: "rename", oldUri: uri(workspace, "src/a.ts"), newUri: uri(workspace, "src/b.ts") },
			{ kind: "delete", uri: uri(workspace, "src/a.ts") },
		]) {
			expect(
				await codeOf(decodeWorkspaceEdit({ documentChanges: [operation] }, { workspaceRoot: workspace.root })),
			).toBe("UNSUPPORTED_RESOURCE_OPERATION");
		}
		expect(workspace.readText("src/a.ts")).toBe("x\n");
	});

	it("refuses an edit for a document version the client does not hold", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\n" });
		const edit = (version: number | null) => ({
			documentChanges: [
				{ textDocument: { uri: uri(workspace, "src/a.ts"), version }, edits: [textEdit(0, 0, 1, "y")] },
			],
		});

		expect(await codeOf(decodeWorkspaceEdit(edit(3), { workspaceRoot: workspace.root, knownVersion: () => 4 }))).toBe(
			"SNAPSHOT_STALE",
		);
		expect(await codeOf(decodeWorkspaceEdit(edit(3), { workspaceRoot: workspace.root }))).toBe("SNAPSHOT_STALE");
		const accepted = await decodeWorkspaceEdit(edit(3), { workspaceRoot: workspace.root, knownVersion: () => 3 });
		expect(accepted.files[0].afterText).toBe("y\n");
		// A closed document has no version; its base hash is what protects it at commit time.
		const closed = await decodeWorkspaceEdit(edit(null), { workspaceRoot: workspace.root });
		expect(closed.files[0].baseHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses files outside the workspace, missing files, malformed input and non-file URIs", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\n" });
		const options = { workspaceRoot: workspace.root };

		expect(
			await codeOf(
				decodeWorkspaceEdit({ changes: { "file:///C:/Windows/win.ini": [textEdit(0, 0, 1, "y")] } }, options),
			),
		).toBe("PATH_OUT_OF_SCOPE");
		expect(
			await codeOf(decodeWorkspaceEdit({ changes: { "untitled:Untitled-1": [textEdit(0, 0, 1, "y")] } }, options)),
		).toBe("PATH_OUT_OF_SCOPE");
		expect(
			await codeOf(
				decodeWorkspaceEdit({ changes: { [uri(workspace, "src/missing.ts")]: [textEdit(0, 0, 0, "y")] } }, options),
			),
		).toBe("INVALID_EDIT");
		expect(await codeOf(decodeWorkspaceEdit("nope", options))).toBe("INVALID_EDIT");
		expect(
			await codeOf(decodeWorkspaceEdit({ changes: { [uri(workspace, "src/a.ts")]: [{ newText: 1 }] } }, options)),
		).toBe("INVALID_EDIT");
		expect(
			await codeOf(
				decodeWorkspaceEdit({ changes: { [uri(workspace, "src/a.ts")]: [textEdit(5, 0, 5, "y")] } }, options),
			),
		).toBe("INVALID_EDIT");
	});

	it("keeps CRLF and a BOM, and drops files an edit leaves unchanged", async () => {
		const workspace = createTestWorkspace({
			"src/crlf.ts": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("let a = 1;\r\nlet b = 2;\r\n")]),
			"src/same.ts": "keep\n",
		});

		const decoded = await decodeWorkspaceEdit(
			{
				changes: {
					[uri(workspace, "src/crlf.ts")]: [textEdit(1, 4, 5, "c"), textEdit(1, 8, 9, "3;\nlet d = 4")],
					[uri(workspace, "src/same.ts")]: [textEdit(0, 0, 4, "keep")],
				},
			},
			{ workspaceRoot: workspace.root },
		);

		expect(decoded.files.map((file) => file.path)).toEqual(["src/crlf.ts"]);
		expect(decoded.files[0].format).toEqual({ bom: "utf8", eol: "\r\n" });
		expect(decoded.files[0].afterText).toBe("let a = 1;\r\nlet c = 3;\r\nlet d = 4;\r\n");
	});

	it("asks for confirmation when an annotation requires it", async () => {
		const workspace = createTestWorkspace({ "src/a.ts": "x\n" });

		const decoded = await decodeWorkspaceEdit(
			{
				changeAnnotations: { risky: { label: "Rename a public export", needsConfirmation: true } },
				documentChanges: [
					{
						textDocument: { uri: uri(workspace, "src/a.ts"), version: null },
						edits: [{ ...textEdit(0, 0, 1, "y"), annotationId: "risky" }],
					},
				],
			},
			{ workspaceRoot: workspace.root },
		);

		expect(decoded.needsConfirmation).toEqual(["Rename a public export"]);
		expect(
			await codeOf(
				decodeWorkspaceEdit(
					{
						documentChanges: [
							{
								textDocument: { uri: uri(workspace, "src/a.ts"), version: null },
								edits: [{ ...textEdit(0, 0, 1, "y"), annotationId: "unknown" }],
							},
						],
					},
					{ workspaceRoot: workspace.root },
				),
			),
		).toBe("INVALID_EDIT");
	});
});
