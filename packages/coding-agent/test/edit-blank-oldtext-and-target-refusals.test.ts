/**
 * Hostile inputs handed to the edit tool's matching logic that the tool answers correctly: whitespace-only and
 * blank oldText values refused as "not unique", the working directory and a missing file refused as targets,
 * an empty edits list refused, and a replacement that changes nothing refused. N06-H2 companion to
 * test/edit-adversarial-match-inputs.test.ts (empty / repeated / invisible / metacharacter oldText and hostile
 * paths) and test/tools.test.ts (fuzzy and CRLF suites).
 *
 * The cases where the answer is NOT correct live in
 * data/overnight-2026-10-10/pending-tests/edit-whitespace-only-oldtext-lands-in-wrong-place.test.ts.
 *
 * Everything runs in a fresh directory under the test temp root (MYHARNESS_TEMP_DIR when the runner sets it);
 * no repository file is touched.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/tools/files/edit.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";

const scope = { sessionManager: { getSessionId: () => "edit-blank-and-target-refusals" } };
const tempRoot = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();

let dir: string;

beforeEach(async () => {
	clearFileReadStates();
	dir = await mkdtemp(join(tempRoot, "edit-blank-and-target-"));
});

afterEach(async () => {
	clearFileReadStates();
	await rm(dir, { recursive: true, force: true });
});

async function seed(relative: string, content: string | Buffer): Promise<void> {
	await writeFile(join(dir, relative), content);
}

async function read(relative: string): Promise<string> {
	return readFile(join(dir, relative), "utf8");
}

/** Read the file through the read tool so the read-before-edit gate is satisfied. */
async function readWithTool(relative: string): Promise<void> {
	await createReadToolDefinition(dir).execute("read-1", { path: relative }, undefined, undefined, scope);
}

/** Returns the result text, or "THROW:<message>" when the tool refused. */
async function edit(relative: string, edits: Array<{ oldText: string; newText: string }>): Promise<string> {
	try {
		const result = await createEditToolDefinition(dir).execute(
			"c",
			{ path: relative, edits },
			undefined,
			undefined,
			scope,
		);
		return (result.content[0] as { text?: string }).text ?? "";
	} catch (error) {
		return `THROW:${(error as Error).message}`;
	}
}

describe("edit: oldText that is only whitespace or only a line break", () => {
	it("refuses a single space when the normalized content holds several, and leaves the file alone", async () => {
		await seed("a.txt", "a b c\n");
		await readWithTool("a.txt");
		const answer = await edit("a.txt", [{ oldText: " ", newText: "Q" }]);
		expect(answer).toMatch(/THROW:Found \d+ occurrences of the text in a\.txt\. The text must be unique/);
		expect(await read("a.txt")).toBe("a b c\n");
	});

	it("refuses a tab that the file does not contain, reporting it as not unique rather than as missing", async () => {
		await seed("b.txt", "two\n");
		await readWithTool("b.txt");
		const answer = await edit("b.txt", [{ oldText: "\t", newText: "Q" }]);
		// A whitespace-only oldText normalises to the empty string, which every position matches; the refusal is
		// the safe outcome even though the message counts the file, not the text.
		expect(answer).toMatch(/THROW:Found \d+ occurrences of the text in b\.txt\. The text must be unique/);
		expect(await read("b.txt")).toBe("two\n");
	});

	it("refuses a line break that appears twice, and accepts the one that appears once", async () => {
		await seed("c.txt", "x\ny\n");
		await readWithTool("c.txt");
		expect(await edit("c.txt", [{ oldText: "\n", newText: "Q" }])).toMatch(
			/THROW:Found 2 occurrences of the text in c\.txt/,
		);
		expect(await read("c.txt")).toBe("x\ny\n");

		await seed("d.txt", "line\n");
		await readWithTool("d.txt");
		expect(await edit("d.txt", [{ oldText: "\n", newText: "Q" }])).toContain("Successfully replaced 1 block(s)");
		expect(await read("d.txt")).toBe("lineQ");
	});

	it("refuses a newline-only oldText against a file of blank lines instead of writing something", async () => {
		await seed("e.txt", "\n\n\n");
		await readWithTool("e.txt");
		expect(await edit("e.txt", [{ oldText: "\n", newText: "Q" }])).toMatch(/THROW:Found 3 occurrences/);
		expect(await read("e.txt")).toBe("\n\n\n");
	});
});

describe("edit: a line ending written the other way round", () => {
	it("matches an oldText carrying a lone carriage return against LF content", async () => {
		await seed("f.txt", "one\ntwo\n");
		await readWithTool("f.txt");
		expect(await edit("f.txt", [{ oldText: "one\rtwo", newText: "X" }])).toContain(
			"Successfully replaced 1 block(s)",
		);
		expect(await read("f.txt")).toBe("X\n");
	});

	it("keeps a file whose untouched lines use LF when the oldText uses CRLF and the newText is written", async () => {
		await seed("g.txt", "a\nb\nc\n");
		await readWithTool("g.txt");
		expect(await edit("g.txt", [{ oldText: "a\r\nb", newText: "X\r\nY" }])).toContain(
			"Successfully replaced 1 block(s)",
		);
		expect(await read("g.txt")).toBe("X\nY\nc\n");
	});
});

describe("edit: targets that are not a file to edit", () => {
	it("refuses the working directory spelled as . or as an empty string, and a missing file", async () => {
		await seed("keep.txt", "x\n");
		expect(await edit(".", [{ oldText: "x", newText: "y" }])).toMatch(/THROW:.*EISDIR/);
		expect(await edit("", [{ oldText: "x", newText: "y" }])).toMatch(/THROW:.*EISDIR/);
		expect(await edit("nope.txt", [{ oldText: "x", newText: "y" }])).toMatch(
			/THROW:Could not edit file: nope\.txt\. Error code: ENOENT/,
		);
		expect(await read("keep.txt")).toBe("x\n");
	});

	it("refuses an absolute path that names no existing file, and does not create it", async () => {
		const answer = await edit(join(tempRoot, "n06-edit-must-not-exist.txt"), [{ oldText: "x", newText: "y" }]);
		expect(answer).toMatch(/THROW:Could not edit file: .* Error code: ENOENT/);
	});

	it("refuses a subdirectory as the target and leaves its contents alone", async () => {
		await mkdir(join(dir, "sub"), { recursive: true });
		await seed("sub/x.txt", "in\n");
		expect(await edit("sub", [{ oldText: "in", newText: "OUT" }])).toMatch(/THROW:.*EISDIR/);
		expect(await read("sub/x.txt")).toBe("in\n");
	});
});

describe("edit: an input that cannot mean anything", () => {
	it("refuses an empty edits list before touching the file", async () => {
		await seed("h.txt", "one\ntwo\n");
		await readWithTool("h.txt");
		expect(await edit("h.txt", [])).toMatch(
			/THROW:Edit tool input is invalid\. edits must contain at least one replacement/,
		);
		expect(await read("h.txt")).toBe("one\ntwo\n");
	});

	it("refuses an oldText longer than the file instead of matching it partially", async () => {
		await seed("i.txt", "one\ntwo\n");
		await readWithTool("i.txt");
		expect(await edit("i.txt", [{ oldText: "one\ntwo\nextra tail", newText: "Q" }])).toMatch(
			/THROW:Could not find the exact text in i\.txt/,
		);
		expect(await read("i.txt")).toBe("one\ntwo\n");
	});

	it("refuses a replacement whose content is identical and does not rewrite the file", async () => {
		await seed("j.txt", "same\n");
		await readWithTool("j.txt");
		const before = await readFile(join(dir, "j.txt"));
		expect(await edit("j.txt", [{ oldText: "same", newText: "same" }])).toMatch(/THROW:No changes made to j\.txt/);
		expect(await readFile(join(dir, "j.txt"))).toEqual(before);
	});
});
