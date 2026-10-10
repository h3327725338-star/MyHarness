/**
 * Adversarial and malformed inputs handed to the edit tool's matching logic: empty, repeated, invisible,
 * literal-metacharacter and wrong-line-ending oldText, hostile paths, and what is left on disk when a match
 * is refused.
 *
 * N06-H2 companion to test/tools.test.ts (fuzzy / CRLF suites), test/edit-tool-legacy-input.test.ts and
 * test/read-state.test.ts. Every case runs in a fresh directory under the test temp root and never touches a
 * repository file.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/tools/files/edit.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";

const scope = { sessionManager: { getSessionId: () => "edit-adversarial-match-inputs" } };
const tempRoot = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();

let dir: string;

beforeEach(async () => {
	clearFileReadStates();
	dir = await mkdtemp(join(tempRoot, "edit-adversarial-match-inputs-"));
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

async function editThrows(relative: string, edits: Array<{ oldText: string; newText: string }>): Promise<Error> {
	try {
		await createEditToolDefinition(dir).execute("c", { path: relative, edits }, undefined, undefined, scope);
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the edit to be refused");
}

/** Seed, read through the read tool (the gate), and edit. Returns the refusal or success text. */
async function readThenEdit(
	relative: string,
	content: string | Buffer,
	edits: Array<{ oldText: string; newText: string }>,
): Promise<string> {
	await seed(relative, content);
	await createReadToolDefinition(dir).execute("read-1", { path: relative }, undefined, undefined, scope);
	return edit(relative, edits);
}

describe("edit: oldText that must be refused", () => {
	it("refuses an empty oldText and leaves the file untouched", async () => {
		const text = await readThenEdit("a.txt", "hello\n", [{ oldText: "", newText: "X" }]);
		expect(text).toContain("oldText must not be empty in a.txt.");
		expect(await read("a.txt")).toBe("hello\n");
	});

	it("refuses one empty oldText inside a multi-edit call and names its index", async () => {
		const text = await readThenEdit("b.txt", "one\ntwo\n", [
			{ oldText: "one", newText: "ONE" },
			{ oldText: "", newText: "X" },
		]);
		expect(text).toContain("edits[1].oldText must not be empty in b.txt.");
		expect(await read("b.txt")).toBe("one\ntwo\n");
	});

	it("refuses an oldText that appears several times and counts the occurrences", async () => {
		const text = await readThenEdit("c.txt", "foo foo foo\n", [{ oldText: "foo", newText: "bar" }]);
		expect(text).toContain("Found 3 occurrences of the text in c.txt.");
		expect(await read("c.txt")).toBe("foo foo foo\n");
	});

	it("refuses a replacement that changes nothing instead of rewriting the file", async () => {
		const text = await readThenEdit("d.txt", "abc\n", [{ oldText: "abc", newText: "abc" }]);
		expect(text).toContain("No changes made to d.txt.");
		expect(await read("d.txt")).toBe("abc\n");
	});

	it("refuses two edits whose regions overlap and applies neither", async () => {
		const text = await readThenEdit("e.txt", "a\nb\nc\n", [
			{ oldText: "a\nb", newText: "A\nB" },
			{ oldText: "b\nc", newText: "B\nC" },
		]);
		expect(text).toContain("overlap in e.txt");
		expect(await read("e.txt")).toBe("a\nb\nc\n");
	});

	it("refuses the same oldText sent twice in one call", async () => {
		const text = await readThenEdit("f.txt", "a\n", [
			{ oldText: "a", newText: "A" },
			{ oldText: "a", newText: "A" },
		]);
		expect(text).toContain("overlap in f.txt");
		expect(await read("f.txt")).toBe("a\n");
	});
});

describe("edit: oldText is matched as literal text, never as a pattern", () => {
	it("replaces regex metacharacters literally and does not touch what only a regex would match", async () => {
		const text = await readThenEdit("g.txt", "a.*b and axxb\n", [{ oldText: "a.*b", newText: "Q" }]);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(await read("g.txt")).toBe("Q and axxb\n");
	});

	it("replaces replacement-pattern characters ($1, &, backtick) literally", async () => {
		const text = await readThenEdit("h.txt", "$1&`\n", [{ oldText: "$1&`", newText: "X" }]);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(await read("h.txt")).toBe("X\n");
	});

	it("does not fuzzy-match across an invisible zero width space in either direction", async () => {
		const text = await readThenEdit("i.txt", "ab\n", [{ oldText: "a\u200Bb", newText: "X" }]);
		expect(text).toContain("Could not find the exact text in i.txt");
		expect(await read("i.txt")).toBe("ab\n");

		const other = await readThenEdit("j.txt", "a\u200Bb\n", [{ oldText: "ab", newText: "X" }]);
		expect(other).toContain("Could not find the exact text in j.txt");
		expect(await read("j.txt")).toBe("a\u200Bb\n");
	});
});

describe("edit: line endings and the byte order mark", () => {
	it("matches LF oldText across a CRLF file and keeps CRLF on the untouched lines", async () => {
		const text = await readThenEdit("k.txt", "a\r\nb\r\nc\r\n", [{ oldText: "a\nb", newText: "X\nY" }]);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(await readFile(join(dir, "k.txt"), "utf8")).toBe("X\r\nY\r\nc\r\n");
	});

	it("matches CRLF oldText against an LF file and keeps the file on LF", async () => {
		const text = await readThenEdit("l.txt", "a\nb\nc\n", [{ oldText: "a\r\nb", newText: "X\r\nY" }]);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(await read("l.txt")).toBe("X\nY\nc\n");
	});

	it("keeps the BOM when oldText omits it, and refuses an oldText that includes it", async () => {
		const text = await readThenEdit("m.txt", Buffer.from("\uFEFFabc\n", "utf8"), [{ oldText: "abc", newText: "X" }]);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(await read("m.txt")).toBe("\uFEFFX\n");

		const other = await readThenEdit("n.txt", Buffer.from("\uFEFFabc\n", "utf8"), [
			{ oldText: "\uFEFFabc", newText: "X" },
		]);
		expect(other).toContain("Could not find the exact text in n.txt");
		expect(await read("n.txt")).toBe("\uFEFFabc\n");
	});

	it("deletes a line when newText is empty", async () => {
		const text = await readThenEdit("o.txt", "alpha\nbeta\n", [{ oldText: "beta\n", newText: "" }]);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(await read("o.txt")).toBe("alpha\n");
	});
});

describe("edit: hostile paths", () => {
	it("refuses a path containing a NUL byte with an argument error and no write", async () => {
		await seed("keep.txt", "x\n");
		const error = await editThrows("a\u0000b.txt", [{ oldText: "x", newText: "y" }]);
		expect(error.message).toMatch(/Could not edit file.*Error code: ERR_INVALID_ARG_VALUE/);
		expect(await read("keep.txt")).toBe("x\n");
	});

	it("refuses a directory as the edit target instead of reading or replacing it", async () => {
		await mkdir(join(dir, "sub"), { recursive: true });
		await writeFile(join(dir, "sub", "x.txt"), "in\n");
		const error = await editThrows("sub", [{ oldText: "in", newText: "OUT" }]);
		expect(`${error.name}: ${error.message}`).toMatch(/EISDIR/);
		expect(await read("sub/x.txt")).toBe("in\n");
	});

	it("refuses the edit of an existing file that was never read, keeping the read-before-edit gate", async () => {
		await seed("gate.txt", "a\n");
		clearFileReadStates();
		const error = await editThrows("gate.txt", [{ oldText: "a", newText: "b" }]);
		expect((error as Error & { code?: string }).code).toBe("FILE_NOT_READ");
		expect(await read("gate.txt")).toBe("a\n");
	});

	it("refuses an edit after the file changed on disk, with FILE_STALE", async () => {
		await seed("stale.txt", "short\n");
		await createReadToolDefinition(dir).execute("read-1", { path: "stale.txt" }, undefined, undefined, scope);
		await writeFile(join(dir, "stale.txt"), "a much longer replacement line\n");
		const error = await editThrows("stale.txt", [{ oldText: "short", newText: "S" }]);
		expect((error as Error & { code?: string }).code).toBe("FILE_STALE");
		expect(await read("stale.txt")).toBe("a much longer replacement line\n");
	});
});
