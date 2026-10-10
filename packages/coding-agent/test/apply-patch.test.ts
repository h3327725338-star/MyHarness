import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModel } from "@myharness/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDelegatedToolNames,
	restrictToolNamesForRole,
	setDelegatedCapabilities,
} from "../src/agent/runtime/role.ts";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { DefaultResourceLoader } from "../src/application/resource-loader.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { createApplyPatchTool, createApplyPatchToolDefinition } from "../src/tools/files/apply-patch.ts";
import { parseApplyPatch } from "../src/tools/files/apply-patch-parser.ts";
import { createEditToolDefinition } from "../src/tools/files/edit.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";
import { allToolNames, createAllToolDefinitions, createAllTools } from "../src/tools/registry.ts";

// Hooks around the atomic writer, so a test can fail or cancel a specific write. Every write, including the
// undo writes of a rollback, goes through them.
const writeHooks = vi.hoisted(() => ({
	beforeWrite: undefined as ((filePath: string) => void) | undefined,
	afterWrite: undefined as ((filePath: string) => void) | undefined,
}));

vi.mock("../src/utils/atomic-write.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/atomic-write.ts")>();
	return {
		...actual,
		writeFileAtomically: async (filePath: string, content: string | Uint8Array) => {
			writeHooks.beforeWrite?.(filePath);
			await actual.writeFileAtomically(filePath, content);
			writeHooks.afterWrite?.(filePath);
		},
	};
});

/** Tool context: the Session the read state is scoped to. */
const scope = { sessionManager: { getSessionId: () => "apply-patch-test-session" } };

let dir: string;

beforeEach(async () => {
	clearFileReadStates();
	dir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
});

afterEach(async () => {
	writeHooks.beforeWrite = undefined;
	writeHooks.afterWrite = undefined;
	setDelegatedCapabilities(undefined);
	clearFileReadStates();
	await rm(dir, { recursive: true, force: true });
});

function patchText(...lines: string[]): string {
	return lines.join("\n");
}

async function applyPatch(text: string, signal?: AbortSignal) {
	return createApplyPatchToolDefinition(dir).execute("call-1", { patch: text }, signal, undefined, scope);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

async function readWithTool(relative: string): Promise<void> {
	await createReadToolDefinition(dir).execute("read-1", { path: relative }, undefined, undefined, scope);
}

async function seed(relative: string, content: string | Buffer): Promise<void> {
	await mkdir(dirname(join(dir, relative)), { recursive: true });
	await writeFile(join(dir, relative), content);
}

async function textAt(relative: string): Promise<string> {
	return readFile(join(dir, relative), "utf8");
}

async function exists(relative: string): Promise<boolean> {
	return stat(join(dir, relative)).then(
		() => true,
		() => false,
	);
}

async function errorOf(promise: Promise<unknown>): Promise<Error & { code?: string }> {
	try {
		await promise;
	} catch (error) {
		return error as Error & { code?: string };
	}
	throw new Error("expected the call to fail");
}

describe("apply_patch parser", () => {
	it("parses an add section into the complete new file", () => {
		expect(
			parseApplyPatch(
				patchText("*** Begin Patch", "*** Add File: notes/a.txt", "+one", "+", "+two", "*** End Patch"),
			),
		).toEqual([{ type: "add", path: "notes/a.txt", content: "one\n\ntwo\n", line: 2 }]);
	});

	it("parses a delete section with no body", () => {
		expect(parseApplyPatch(patchText("*** Begin Patch", "*** Delete File: old.txt", "*** End Patch"))).toEqual([
			{ type: "delete", path: "old.txt", line: 2 },
		]);
	});

	it("parses an update section with anchored and bare hunks and an end-of-file marker", () => {
		const operations = parseApplyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: src/app.ts",
				"@@ function main() {",
				" const a = 1;",
				"-const b = 2;",
				"+const b = 3;",
				"@@",
				" tail();",
				"+more();",
				"*** End of File",
				"*** End Patch",
			),
		);
		expect(operations).toEqual([
			{
				type: "update",
				path: "src/app.ts",
				line: 2,
				hunks: [
					{
						anchor: "function main() {",
						endOfFile: false,
						line: 3,
						lines: [
							{ kind: " ", text: "const a = 1;" },
							{ kind: "-", text: "const b = 2;" },
							{ kind: "+", text: "const b = 3;" },
						],
					},
					{
						endOfFile: true,
						line: 7,
						lines: [
							{ kind: " ", text: "tail();" },
							{ kind: "+", text: "more();" },
						],
					},
				],
			},
		]);
	});

	it("parses a move with no hunks as a rename and a move with hunks as an update", () => {
		const [rename, edit] = parseApplyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: a.txt",
				"*** Move to: b.txt",
				"*** Update File: c.txt",
				"*** Move to: d.txt",
				"@@",
				"-x",
				"+y",
				"*** End Patch",
			),
		);
		expect(rename).toMatchObject({ type: "update", path: "a.txt", moveTo: "b.txt", hunks: [] });
		expect(edit).toMatchObject({ type: "update", path: "c.txt", moveTo: "d.txt" });
	});

	it("accepts a first hunk without @@ and treats a blank line inside a hunk as an empty context line", () => {
		const [operation] = parseApplyPatch(
			patchText("*** Begin Patch", "*** Update File: a.txt", " keep", "", "-old", "+new", "*** End Patch"),
		);
		expect(operation).toMatchObject({
			type: "update",
			hunks: [
				{
					anchor: undefined,
					lines: [
						{ kind: " ", text: "keep" },
						{ kind: " ", text: "" },
						{ kind: "-", text: "old" },
						{ kind: "+", text: "new" },
					],
				},
			],
		});
	});

	it("ignores blank separator lines between sections and before the end", () => {
		const operations = parseApplyPatch(
			patchText(
				"",
				"*** Begin Patch",
				"*** Add File: a.txt",
				"+x",
				"",
				"*** Delete File: b.txt",
				"",
				"*** End Patch",
				"",
			),
		);
		expect(operations.map((operation) => operation.type)).toEqual(["add", "delete"]);
	});

	it("accepts CRLF line endings in the patch text", () => {
		expect(parseApplyPatch("*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch\r\n")).toEqual([
			{ type: "add", path: "a.txt", content: "x\n", line: 2 },
		]);
	});

	it("rejects a patch that does not start with Begin Patch", () => {
		expect(() => parseApplyPatch(patchText("*** Add File: a.txt", "+x", "*** End Patch"))).toThrow(/must start with/);
	});

	it("rejects a patch without End Patch", () => {
		expect(() => parseApplyPatch(patchText("*** Begin Patch", "*** Add File: a.txt", "+x"))).toThrow(
			/missing "\*\*\* End Patch"/,
		);
	});

	it("rejects a line that is not a file section", () => {
		expect(() => parseApplyPatch(patchText("*** Begin Patch", "hello", "*** End Patch"))).toThrow(
			/expected "\*\*\* Add File:"/,
		);
	});

	it("rejects an Add File line that does not start with +", () => {
		expect(() =>
			parseApplyPatch(patchText("*** Begin Patch", "*** Add File: a.txt", "+ok", "not added", "*** End Patch")),
		).toThrow(/must start with "\+"/);
	});

	it("rejects an empty patch", () => {
		expect(() => parseApplyPatch("   \n")).toThrow(/is empty/);
	});

	it("rejects a patch with no file operation", () => {
		expect(() => parseApplyPatch(patchText("*** Begin Patch", "*** End Patch"))).toThrow(/no file operations/);
	});

	it("rejects an unknown directive", () => {
		expect(() => parseApplyPatch(patchText("*** Begin Patch", "*** Rename File: a.txt", "*** End Patch"))).toThrow(
			/unknown or misplaced directive/,
		);
	});

	it("rejects a Move to line that comes after the hunks", () => {
		expect(() =>
			parseApplyPatch(
				patchText(
					"*** Begin Patch",
					"*** Update File: a.txt",
					"@@",
					"-x",
					"+y",
					"*** Move to: b.txt",
					"*** End Patch",
				),
			),
		).toThrow(/unknown or misplaced directive/);
	});

	it("rejects content lines in a Delete File section", () => {
		expect(() =>
			parseApplyPatch(patchText("*** Begin Patch", "*** Delete File: a.txt", "-x", "*** End Patch")),
		).toThrow(/takes no content lines/);
	});

	it("rejects an Update File section with neither hunks nor Move to", () => {
		expect(() => parseApplyPatch(patchText("*** Begin Patch", "*** Update File: a.txt", "*** End Patch"))).toThrow(
			/needs at least one hunk/,
		);
	});

	it("rejects an @@ hunk with no lines", () => {
		expect(() =>
			parseApplyPatch(
				patchText("*** Begin Patch", "*** Update File: a.txt", "@@", "@@", "-x", "+y", "*** End Patch"),
			),
		).toThrow(/has no lines/);
	});

	it("rejects a hunk line with no valid prefix", () => {
		expect(() =>
			parseApplyPatch(patchText("*** Begin Patch", "*** Update File: a.txt", "@@", "x foo", "*** End Patch")),
		).toThrow(/unexpected line in an Update File section/);
	});

	it("rejects a hunk line after *** End of File without a new @@", () => {
		expect(() =>
			parseApplyPatch(
				patchText(
					"*** Begin Patch",
					"*** Update File: a.txt",
					"@@",
					" x",
					"+y",
					"*** End of File",
					" z",
					"*** End Patch",
				),
			),
		).toThrow(/follows "\*\*\* End of File"/);
	});

	it("rejects anything after *** End Patch", () => {
		expect(() =>
			parseApplyPatch(patchText("*** Begin Patch", "*** Add File: a.txt", "+x", "*** End Patch", "extra")),
		).toThrow(/nothing may follow/);
	});
});

describe("apply_patch application", () => {
	it("adds a new file, creating its parent directories", async () => {
		const result = await applyPatch(
			patchText("*** Begin Patch", "*** Add File: deep/new/file.txt", "+alpha", "+beta", "*** End Patch"),
		);
		expect(await textAt("deep/new/file.txt")).toBe("alpha\nbeta\n");
		expect(textOf(result)).toBe("Applied patch to 1 file(s):\nA deep/new/file.txt");
		expect(result.details?.files).toEqual([
			{ operation: "add", path: "deep/new/file.txt", diff: expect.any(String), linesAdded: 2, linesRemoved: 0 },
		]);
	});

	it("refuses to add over an existing file and leaves it untouched", async () => {
		await seed("exists.txt", "keep\n");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Add File: exists.txt", "+new", "*** End Patch")),
		);
		expect(error.message).toContain("already exists");
		expect(await textAt("exists.txt")).toBe("keep\n");
	});

	it("deletes a file that was read", async () => {
		await seed("old.txt", "bye\n");
		await readWithTool("old.txt");
		const result = await applyPatch(patchText("*** Begin Patch", "*** Delete File: old.txt", "*** End Patch"));
		expect(await exists("old.txt")).toBe(false);
		expect(textOf(result)).toContain("D old.txt");
	});

	it("refuses to delete a file that was never read", async () => {
		await seed("old.txt", "bye\n");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Delete File: old.txt", "*** End Patch")),
		);
		expect(error.code).toBe("FILE_NOT_READ");
		expect(await exists("old.txt")).toBe(true);
	});

	it("refuses to delete a file that does not exist", async () => {
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Delete File: missing.txt", "*** End Patch")),
		);
		expect(error.message).toContain("does not exist");
	});

	it("updates a file, and a hunk without @@ is allowed for the first hunk", async () => {
		await seed("app.ts", "one\ntwo\nthree\n");
		await readWithTool("app.ts");
		const result = await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: app.ts",
				" one",
				"-two",
				"+TWO",
				"+2.5",
				" three",
				"*** End Patch",
			),
		);
		expect(await textAt("app.ts")).toBe("one\nTWO\n2.5\nthree\n");
		expect(textOf(result)).toContain("M app.ts (+2 -1)");
		expect(result.details?.files[0]?.diff).toContain("TWO");
	});

	it("renames a file with Move to and keeps its content", async () => {
		await seed("old-name.txt", "keep me\n");
		await readWithTool("old-name.txt");
		const result = await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: old-name.txt",
				"*** Move to: new/place/new-name.txt",
				"*** End Patch",
			),
		);
		expect(await exists("old-name.txt")).toBe(false);
		expect(await textAt("new/place/new-name.txt")).toBe("keep me\n");
		expect(textOf(result)).toBe("Applied patch to 1 file(s):\nR old-name.txt -> new/place/new-name.txt");
	});

	it("moves a file and applies its hunks at the new path", async () => {
		await seed("a.txt", "x\ny\n");
		await readWithTool("a.txt");
		const result = await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: a.txt",
				"*** Move to: b.txt",
				"@@",
				" x",
				"-y",
				"+Y",
				"*** End Patch",
			),
		);
		expect(await exists("a.txt")).toBe(false);
		expect(await textAt("b.txt")).toBe("x\nY\n");
		expect(textOf(result)).toContain("R a.txt -> b.txt (+1 -1)");
	});

	it("refuses a Move to target that already exists and leaves both files untouched", async () => {
		await seed("a.txt", "from\n");
		await seed("b.txt", "taken\n");
		await readWithTool("a.txt");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Update File: a.txt", "*** Move to: b.txt", "*** End Patch")),
		);
		expect(error.message).toContain("already exists");
		expect(await textAt("a.txt")).toBe("from\n");
		expect(await textAt("b.txt")).toBe("taken\n");
	});

	it("applies add, update and delete in one patch", async () => {
		await seed("keep.ts", "const a = 1;\n");
		await seed("gone.ts", "bye\n");
		await readWithTool("keep.ts");
		await readWithTool("gone.ts");
		const result = await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Add File: new.ts",
				"+export const n = 1;",
				"*** Update File: keep.ts",
				"@@",
				"-const a = 1;",
				"+const a = 2;",
				"*** Delete File: gone.ts",
				"*** End Patch",
			),
		);
		expect(await textAt("new.ts")).toBe("export const n = 1;\n");
		expect(await textAt("keep.ts")).toBe("const a = 2;\n");
		expect(await exists("gone.ts")).toBe(false);
		expect(textOf(result).split("\n").slice(1)).toEqual(["A new.ts", "M keep.ts (+1 -1)", "D gone.ts"]);
	});

	it("applies several hunks to one file in order", async () => {
		await seed("letters.txt", "a\nb\nc\nd\n");
		await readWithTool("letters.txt");
		await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: letters.txt",
				"@@",
				"-a",
				"+A",
				"@@",
				"-c",
				"+C",
				"*** End Patch",
			),
		);
		expect(await textAt("letters.txt")).toBe("A\nb\nC\nd\n");
	});

	it("searches each hunk only after the end of the previous one", async () => {
		await seed("repeat.txt", "a\nb\na\nb\n");
		await readWithTool("repeat.txt");
		await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: repeat.txt",
				"@@",
				" a",
				"-b",
				"+B",
				"@@",
				" a",
				"-b",
				"+C",
				"*** End Patch",
			),
		);
		expect(await textAt("repeat.txt")).toBe("a\nB\na\nC\n");
	});

	it("does not look back for a hunk that matches only before the previous hunk", async () => {
		await seed("order.txt", "y\nx\n");
		await readWithTool("order.txt");
		const error = await errorOf(
			applyPatch(
				patchText(
					"*** Begin Patch",
					"*** Update File: order.txt",
					"@@",
					"-y",
					"+Y",
					"@@",
					"-y",
					"+Z",
					"*** End Patch",
				),
			),
		);
		expect(error.message).toContain("hunk 2 of 2");
		expect(await textAt("order.txt")).toBe("y\nx\n");
	});

	it("locates a hunk by the @@ text, such as a function signature", async () => {
		await seed("fns.ts", "function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n");
		await readWithTool("fns.ts");
		await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: fns.ts",
				"@@ function b() {",
				"-  return 1;",
				"+  return 2;",
				"*** End Patch",
			),
		);
		expect(await textAt("fns.ts")).toBe("function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n");
	});

	it("inserts lines with only additions right after the @@ line", async () => {
		await seed("imports.ts", "import a;\nconst x = 1;\n");
		await readWithTool("imports.ts");
		await applyPatch(
			patchText("*** Begin Patch", "*** Update File: imports.ts", "@@ import a;", "+import b;", "*** End Patch"),
		);
		expect(await textAt("imports.ts")).toBe("import a;\nimport b;\nconst x = 1;\n");
	});

	it("refuses a hunk with only additions and no position", async () => {
		await seed("plain.txt", "one\n");
		await readWithTool("plain.txt");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Update File: plain.txt", "@@", "+added", "*** End Patch")),
		);
		expect(error.message).toContain("needs an @@ locating text or *** End of File");
		expect(await textAt("plain.txt")).toBe("one\n");
	});

	it("matches a hunk marked End of File from the end of the file", async () => {
		await seed("tail.txt", "x\ny\nx\ny\n");
		await readWithTool("tail.txt");
		await applyPatch(
			patchText("*** Begin Patch", "*** Update File: tail.txt", " y", "+z", "*** End of File", "*** End Patch"),
		);
		expect(await textAt("tail.txt")).toBe("x\ny\nx\ny\nz\n");
	});

	it("tolerates trailing whitespace differences (ladder step 2)", async () => {
		await seed("trail.txt", "foo   \nbar\n");
		await readWithTool("trail.txt");
		await applyPatch(
			patchText("*** Begin Patch", "*** Update File: trail.txt", " foo", "-bar", "+baz", "*** End Patch"),
		);
		expect(await textAt("trail.txt")).toBe("foo   \nbaz\n");
	});

	it("tolerates leading and trailing whitespace differences (ladder step 3), keeping the file's own context", async () => {
		await seed("indent.txt", "  const x = 1;\nold\n");
		await readWithTool("indent.txt");
		await applyPatch(
			patchText("*** Begin Patch", "*** Update File: indent.txt", " const x = 1;", "-old", "+new", "*** End Patch"),
		);
		expect(await textAt("indent.txt")).toBe("  const x = 1;\nnew\n");
	});

	it("tolerates curly quotes and dashes (ladder step 4), keeping the file's own context", async () => {
		await seed("typo.txt", "const s = “hi” – ok;\nkeep\n");
		await readWithTool("typo.txt");
		await applyPatch(
			patchText(
				"*** Begin Patch",
				"*** Update File: typo.txt",
				' const s = "hi" - ok;',
				"-keep",
				"+kept",
				"*** End Patch",
			),
		);
		expect(await textAt("typo.txt")).toBe("const s = “hi” – ok;\nkept\n");
	});

	it("keeps CRLF line endings of an existing file", async () => {
		await seed("crlf.txt", "a\r\nb\r\nc\r\n");
		await readWithTool("crlf.txt");
		await applyPatch(patchText("*** Begin Patch", "*** Update File: crlf.txt", " a", "-b", "+B", "*** End Patch"));
		expect(await readFile(join(dir, "crlf.txt"))).toEqual(Buffer.from("a\r\nB\r\nc\r\n"));
	});

	it("does not add a final line break to a file that had none", async () => {
		await seed("no-eol.txt", "a\nb");
		await readWithTool("no-eol.txt");
		await applyPatch(patchText("*** Begin Patch", "*** Update File: no-eol.txt", " a", "-b", "+B", "*** End Patch"));
		expect(await textAt("no-eol.txt")).toBe("a\nB");
	});

	it("keeps the byte order mark of an existing file", async () => {
		await seed("bom.txt", Buffer.from("﻿a\nb\n", "utf8"));
		await readWithTool("bom.txt");
		await applyPatch(patchText("*** Begin Patch", "*** Update File: bom.txt", " a", "-b", "+B", "*** End Patch"));
		const bytes = await readFile(join(dir, "bom.txt"));
		expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		expect(bytes.toString("utf8")).toBe("﻿a\nB\n");
	});

	it("writes nothing when a later file's hunk does not match (atomicity)", async () => {
		await seed("a.txt", "one\n");
		await seed("b.txt", "two\n");
		await readWithTool("a.txt");
		await readWithTool("b.txt");
		const error = await errorOf(
			applyPatch(
				patchText(
					"*** Begin Patch",
					"*** Update File: a.txt",
					"-one",
					"+ONE",
					"*** Update File: b.txt",
					" nothing here",
					"-here",
					"+there",
					"*** End Patch",
				),
			),
		);
		expect(error.message).toContain("b.txt");
		expect(error.message).toContain("hunk 1 of 1");
		expect(await textAt("a.txt")).toBe("one\n");
		expect(await textAt("b.txt")).toBe("two\n");
	});

	it("reports the first lines of a hunk that does not match", async () => {
		await seed("miss.txt", "present\n");
		await readWithTool("miss.txt");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Update File: miss.txt", "-absent line", "+x", "*** End Patch")),
		);
		expect(error.message).toContain("Could not apply hunk 1 of 1 to miss.txt");
		expect(error.message).toContain("-absent line");
	});

	it("restores already written files when a later write fails, and says what happened", async () => {
		await seed("a.txt", "one\n");
		await seed("b.txt", "two\n");
		await readWithTool("a.txt");
		await readWithTool("b.txt");
		writeHooks.beforeWrite = (filePath) => {
			if (filePath.endsWith("b.txt")) throw new Error("simulated disk error");
		};
		const error = await errorOf(
			applyPatch(
				patchText(
					"*** Begin Patch",
					"*** Update File: a.txt",
					"-one",
					"+ONE",
					"*** Update File: b.txt",
					"-two",
					"+TWO",
					"*** End Patch",
				),
			),
		);
		expect(error.message).toContain("simulated disk error");
		expect(error.message).toContain("restored to their earlier state: write a.txt");
		expect(error.message).toContain("Not written: write b.txt");
		expect(await textAt("a.txt")).toBe("one\n");
		expect(await textAt("b.txt")).toBe("two\n");
	});

	it("aborts before any write when the signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Add File: never.txt", "+x", "*** End Patch"), controller.signal),
		);
		expect(error.message).toContain("Operation aborted");
		expect(await exists("never.txt")).toBe(false);
	});

	it("reports committed-after-cancel when cancellation arrives during the writes", async () => {
		const controller = new AbortController();
		writeHooks.afterWrite = () => controller.abort();
		const result = await applyPatch(
			patchText("*** Begin Patch", "*** Add File: one.txt", "+1", "*** Add File: two.txt", "+2", "*** End Patch"),
			controller.signal,
		);
		expect(result.details?.mutationStatus).toBe("committed-after-cancel");
		expect(await textAt("one.txt")).toBe("1\n");
		expect(await textAt("two.txt")).toBe("2\n");
	});

	it("handles paths with spaces", async () => {
		await applyPatch(patchText("*** Begin Patch", "*** Add File: my dir/hello world.txt", "+hi", "*** End Patch"));
		expect(await textAt("my dir/hello world.txt")).toBe("hi\n");
		await readWithTool("my dir/hello world.txt");
		await applyPatch(
			patchText("*** Begin Patch", "*** Update File: my dir/hello world.txt", "-hi", "+hello", "*** End Patch"),
		);
		expect(await textAt("my dir/hello world.txt")).toBe("hello\n");
	});

	it("refuses a file that appears twice in one patch, including a Move target", async () => {
		await seed("same.txt", "x\n");
		await readWithTool("same.txt");
		const addThenDelete = await errorOf(
			applyPatch(
				patchText(
					"*** Begin Patch",
					"*** Add File: fresh.txt",
					"+x",
					"*** Delete File: fresh.txt",
					"*** End Patch",
				),
			),
		);
		expect(addThenDelete.message).toContain("same file");
		const twoUpdates = await errorOf(
			applyPatch(
				patchText(
					"*** Begin Patch",
					"*** Update File: same.txt",
					"-x",
					"+y",
					"*** Update File: same.txt",
					"-y",
					"+z",
					"*** End Patch",
				),
			),
		);
		expect(twoUpdates.message).toContain("same file");
		const moveToItself = await errorOf(
			applyPatch(
				patchText("*** Begin Patch", "*** Update File: same.txt", "*** Move to: same.txt", "*** End Patch"),
			),
		);
		expect(moveToItself.message).toContain("is the same file as");
		expect(await textAt("same.txt")).toBe("x\n");
	});

	it("refuses to update a file that does not exist", async () => {
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Update File: nope.txt", "-x", "+y", "*** End Patch")),
		);
		expect(error.message).toContain("does not exist");
	});

	it("refuses an update of a file that was never read", async () => {
		await seed("unread.txt", "one\n");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Update File: unread.txt", "-one", "+ONE", "*** End Patch")),
		);
		expect(error.code).toBe("FILE_NOT_READ");
		expect(await textAt("unread.txt")).toBe("one\n");
	});

	it("refuses an update of a file that changed since it was read", async () => {
		await seed("moved.txt", "short\n");
		await readWithTool("moved.txt");
		await writeFile(join(dir, "moved.txt"), "a much longer line written by someone else\n");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Update File: moved.txt", "-short", "+SHORT", "*** End Patch")),
		);
		expect(error.code).toBe("FILE_STALE");
		expect(await textAt("moved.txt")).toBe("a much longer line written by someone else\n");
	});

	it("refuses to delete a file that changed since it was read", async () => {
		await seed("gone-later.txt", "short\n");
		await readWithTool("gone-later.txt");
		await writeFile(join(dir, "gone-later.txt"), "a much longer line written by someone else\n");
		const error = await errorOf(
			applyPatch(patchText("*** Begin Patch", "*** Delete File: gone-later.txt", "*** End Patch")),
		);
		expect(error.code).toBe("FILE_STALE");
		expect(await exists("gone-later.txt")).toBe(true);
	});

	it("adds a file without reading anything first", async () => {
		await applyPatch(patchText("*** Begin Patch", "*** Add File: fresh.txt", "+fresh", "*** End Patch"));
		expect(await textAt("fresh.txt")).toBe("fresh\n");
	});

	it("refreshes the read state after a patch, so the next edit is not reported as an external change", async () => {
		await seed("chain.txt", "alpha\n");
		await readWithTool("chain.txt");
		await applyPatch(patchText("*** Begin Patch", "*** Update File: chain.txt", "-alpha", "+beta", "*** End Patch"));
		const edit = await createEditToolDefinition(dir).execute(
			"edit-1",
			{ path: "chain.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
			undefined,
			undefined,
			scope,
		);
		expect(textOf(edit)).toContain("Successfully replaced");
		expect(await textAt("chain.txt")).toBe("gamma\n");
	});

	it("applies a second patch to the same file without reading it again", async () => {
		await seed("again.txt", "one\n");
		await readWithTool("again.txt");
		await applyPatch(patchText("*** Begin Patch", "*** Update File: again.txt", "-one", "+two", "*** End Patch"));
		await applyPatch(patchText("*** Begin Patch", "*** Update File: again.txt", "-two", "+three", "*** End Patch"));
		expect(await textAt("again.txt")).toBe("three\n");
	});
});

describe("apply_patch registration", () => {
	it("is a known built-in tool with a system prompt snippet", () => {
		expect(allToolNames.has("apply_patch")).toBe(true);
		expect(createAllToolDefinitions(dir).apply_patch.name).toBe("apply_patch");
		expect(createAllTools(dir).apply_patch.name).toBe("apply_patch");
		expect(createApplyPatchTool(dir).name).toBe("apply_patch");
		expect(createApplyPatchToolDefinition(dir).promptSnippet).toContain("*** Begin Patch");
	});

	it("is not given to delegated sessions, in either capability mode", () => {
		expect(restrictToolNamesForRole("delegated", ["read", "apply_patch"])).toEqual(["read"]);
		setDelegatedCapabilities("read-write");
		expect(restrictToolNamesForRole("delegated", ["read", "apply_patch", "edit", "write"])).toEqual([
			"read",
			"edit",
			"write",
		]);
		expect(getDelegatedToolNames("read-write")).not.toContain("apply_patch");
	});

	it("is off by default and on when the tool allowlist names it", async () => {
		await mkdir(join(dir, "agent"), { recursive: true });
		const settingsManager = SettingsManager.create(dir, join(dir, "agent"));
		const sessionManager = SessionManager.inMemory(dir);
		const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager });
		await resourceLoader.reload();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const defaults = await createAgentSession({
			cwd: dir,
			agentDir: join(dir, "agent"),
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			await defaults.session.bindExtensions({});
			expect(defaults.session.getAllTools().map((tool) => tool.name)).toContain("apply_patch");
			expect(defaults.session.getActiveToolNames()).not.toContain("apply_patch");
		} finally {
			defaults.session.dispose();
		}

		const allowlisted = await createAgentSession({
			cwd: dir,
			agentDir: join(dir, "agent"),
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(dir),
			resourceLoader,
			tools: ["read", "apply_patch"],
		});
		try {
			await allowlisted.session.bindExtensions({});
			expect(allowlisted.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "apply_patch"]));
		} finally {
			allowlisted.session.dispose();
		}
	});
});
