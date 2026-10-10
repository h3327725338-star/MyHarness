/**
 * Adversarial and hostile *paths and structures* handed to the apply_patch tool: how it refuses a path it
 * cannot address, how two spellings of one file collide, and what stays on disk when a patch fails halfway.
 *
 * N06-H2 companion to test/apply-patch.test.ts. Every patch runs against a fresh directory under the test
 * temp root (MYHARNESS_TEMP_DIR when the runner sets it) and never touches a repository file.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchToolDefinition } from "../src/tools/files/apply-patch.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";

const scope = { sessionManager: { getSessionId: () => "apply-patch-adversarial-paths" } };
const tempRoot = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();

let dir: string;

beforeEach(async () => {
	clearFileReadStates();
	dir = await mkdtemp(join(tempRoot, "apply-patch-adversarial-paths-"));
});

afterEach(async () => {
	clearFileReadStates();
	await rm(dir, { recursive: true, force: true });
});

function p(...lines: string[]): string {
	return lines.join("\n");
}

async function seed(relative: string, content: string | Buffer): Promise<void> {
	const target = join(dir, relative);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
}

async function read(relative: string): Promise<string> {
	return readFile(join(dir, relative), "utf8");
}

function entries(): Promise<string[]> {
	return readdir(dir);
}

async function readWithTool(relative: string): Promise<void> {
	await createReadToolDefinition(dir).execute("read-1", { path: relative }, undefined, undefined, scope);
}

async function applyPatch(patchText: string): Promise<string> {
	const result = await createApplyPatchToolDefinition(dir).execute(
		"c",
		{ patch: patchText },
		undefined,
		undefined,
		scope,
	);
	return (result.content[0] as { text?: string }).text ?? "";
}

async function applyPatchThrows(patchText: string): Promise<Error & { code?: string }> {
	try {
		await createApplyPatchToolDefinition(dir).execute("c", { patch: patchText }, undefined, undefined, scope);
	} catch (error) {
		return error as Error & { code?: string };
	}
	throw new Error("expected the patch to be refused");
}

describe("apply_patch path spellings", () => {
	it("writes a path written with a leading @ onto the file the tool resolved, and names it as written", async () => {
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: @at.txt", "+x", "*** End Patch"))).toContain(
			"A @at.txt",
		);
		expect(await read("at.txt")).toBe("x\n");
		expect(await entries()).toEqual(["at.txt"]);
	});

	it("writes a ./-prefixed path onto the plain name", async () => {
		await applyPatch(p("*** Begin Patch", "*** Add File: ./plain.txt", "+x", "*** End Patch"));
		expect(await read("plain.txt")).toBe("x\n");
		expect(await entries()).toEqual(["plain.txt"]);
	});

	it("refuses two spellings of one file in the same patch and writes nothing", async () => {
		const error = await applyPatchThrows(
			p("*** Begin Patch", "*** Add File: y.txt", "+a", "*** Update File: ./y.txt", "-a", "+b", "*** End Patch"),
		);
		expect(error.message).toMatch(/same file as/);
		expect(await entries()).toEqual([]);
	});

	it("refuses a move chain (a file moved, then its destination moved again) instead of guessing the order", async () => {
		await seed("a.txt", "a\n");
		const error = await applyPatchThrows(
			p(
				"*** Begin Patch",
				"*** Update File: a.txt",
				"*** Move to: b.txt",
				"*** Update File: b.txt",
				"*** Move to: c.txt",
				"*** End Patch",
			),
		);
		expect(error.message).toMatch(/b\.txt is the same file as b\.txt/);
		expect(await read("a.txt")).toBe("a\n");
		expect(await entries()).toEqual(["a.txt"]);
	});

	it("refuses to delete a file and move another one onto that path in the same patch", async () => {
		await seed("f.txt", "F\n");
		await seed("g.txt", "G\n");
		const error = await applyPatchThrows(
			p(
				"*** Begin Patch",
				"*** Delete File: f.txt",
				"*** Update File: g.txt",
				"*** Move to: f.txt",
				"*** End Patch",
			),
		);
		expect(error.message).toMatch(/same file as/);
		expect(await read("f.txt")).toBe("F\n");
		expect(await read("g.txt")).toBe("G\n");
	});
});

describe("apply_patch targets that are not regular files", () => {
	it("refuses to update or delete a directory and leaves the directory alone", async () => {
		await seed("sub/x.txt", "in\n");
		const update = await applyPatchThrows(p("*** Begin Patch", "*** Update File: sub", "-x", "+y", "*** End Patch"));
		expect(update.message).toMatch(/does not exist or is not a regular file/);
		const remove = await applyPatchThrows(p("*** Begin Patch", "*** Delete File: sub", "*** End Patch"));
		expect(remove.message).toMatch(/does not exist or is not a regular file/);
		expect(await read("sub/x.txt")).toBe("in\n");
	});

	it("refuses an Add whose parent path is an existing file, and rolls back the file it already wrote", async () => {
		await seed("keep.txt", "one\n");
		await seed("blocked.txt", "file\n");
		await readWithTool("keep.txt");
		const error = await applyPatchThrows(
			p(
				"*** Begin Patch",
				"*** Update File: keep.txt",
				"-one",
				"+ONE",
				"*** Add File: blocked.txt/child.txt",
				"+x",
				"*** End Patch",
			),
		);
		expect(error.message).toMatch(/could not finish/);
		expect(error.message).toMatch(/Written and then restored to their earlier state: write keep\.txt/);
		expect(error.message).toMatch(/Not written: create blocked\.txt\/child\.txt/);
		expect(await read("keep.txt")).toBe("one\n");
		expect(await read("blocked.txt")).toBe("file\n");
	});

	it("refuses to add over an existing directory", async () => {
		await seed("taken/inside.txt", "in\n");
		const error = await applyPatchThrows(p("*** Begin Patch", "*** Add File: taken", "+x", "*** End Patch"));
		expect(error.message).toMatch(/the file already exists/);
		expect(await read("taken/inside.txt")).toBe("in\n");
	});

	it("refuses to move a file onto an existing directory and leaves both alone", async () => {
		await seed("src.txt", "src\n");
		await seed("dirsub/inside.txt", "inside\n");
		await readWithTool("src.txt");
		const error = await applyPatchThrows(
			p("*** Begin Patch", "*** Update File: src.txt", "*** Move to: dirsub", "*** End Patch"),
		);
		expect(error.message).toMatch(/Could not move src\.txt to dirsub: the target already exists/);
		expect(await read("src.txt")).toBe("src\n");
		expect(await read("dirsub/inside.txt")).toBe("inside\n");
	});

	it("refuses a path containing a NUL byte before writing anything", async () => {
		const error = await applyPatchThrows(p("*** Begin Patch", "*** Add File: n\u0000x.txt", "+x", "*** End Patch"));
		expect(error.message).toMatch(/without null bytes/);
		expect(await entries()).toEqual([]);
	});

	it("refuses a Delete of a directory path spelled with a trailing separator", async () => {
		await seed("sub/x.txt", "in\n");
		const error = await applyPatchThrows(p("*** Begin Patch", "*** Delete File: sub/", "*** End Patch"));
		expect(error.message).toMatch(/does not exist or is not a regular file/);
		expect(await read("sub/x.txt")).toBe("in\n");
	});
});

describe("apply_patch locator behaviour on hostile content", () => {
	it("applies a patch written with CRLF to a CRLF file and keeps CRLF everywhere", async () => {
		await seed("cr.txt", "a\r\nb\r\n");
		await readWithTool("cr.txt");
		const crlfPatch = ["*** Begin Patch", "*** Update File: cr.txt", "@@", "-a", "+A", "*** End Patch"].join("\r\n");
		expect(await applyPatch(crlfPatch)).toContain("M cr.txt (+1 -1)");
		expect(await read("cr.txt")).toBe("A\r\nb\r\n");
	});

	it("writes the added line without a trailing break into an existing empty file", async () => {
		await seed("empty.txt", "");
		await readWithTool("empty.txt");
		expect(
			await applyPatch(
				p("*** Begin Patch", "*** Update File: empty.txt", "+first", "*** End of File", "*** End Patch"),
			),
		).toContain("M empty.txt (+1 -0)");
		expect(await read("empty.txt")).toBe("first");
	});

	it("matches a hunk written in NFC against a file stored in NFD, and the other way round", async () => {
		await seed("nfc.txt", "caf\u00E9\n");
		await readWithTool("nfc.txt");
		await applyPatch(p("*** Begin Patch", "*** Update File: nfc.txt", "-caf\u0065\u0301", "+TEA", "*** End Patch"));
		expect(await read("nfc.txt")).toBe("TEA\n");

		await seed("nfd.txt", "cafe\u0301\n");
		await readWithTool("nfd.txt");
		await applyPatch(p("*** Begin Patch", "*** Update File: nfd.txt", "-caf\u00E9", "+TEA", "*** End Patch"));
		expect(await read("nfd.txt")).toBe("TEA\n");
	});

	it("refuses a hunk line that contains a zero width space instead of matching it loosely", async () => {
		await seed("zw.txt", "ab\n");
		await readWithTool("zw.txt");
		const error = await applyPatchThrows(
			p("*** Begin Patch", "*** Update File: zw.txt", "-a\u200Bb", "+X", "*** End Patch"),
		);
		expect(error.message).toMatch(/were not found at or after line 1/);
		expect(await read("zw.txt")).toBe("ab\n");
	});

	it("takes the first match when a context block repeats, and the last when the hunk is marked End of File", async () => {
		await seed("amb.txt", "same\nold\n---\nsame\nold\n");
		await readWithTool("amb.txt");
		await applyPatch(
			p("*** Begin Patch", "*** Update File: amb.txt", "@@", " same", "-old", "+FIRST", "*** End Patch"),
		);
		expect(await read("amb.txt")).toBe("same\nFIRST\n---\nsame\nold\n");

		await seed("amb2.txt", "same\nold\n---\nsame\nold\n");
		await readWithTool("amb2.txt");
		await applyPatch(
			p(
				"*** Begin Patch",
				"*** Update File: amb2.txt",
				"@@",
				" same",
				"-old",
				"+LAST",
				"*** End of File",
				"*** End Patch",
			),
		);
		expect(await read("amb2.txt")).toBe("same\nold\n---\nsame\nLAST\n");
	});

	it("leaves the file untouched when only the second hunk fails to match", async () => {
		await seed("h.txt", "one\ntwo\n");
		await readWithTool("h.txt");
		const error = await applyPatchThrows(
			p("*** Begin Patch", "*** Update File: h.txt", "@@", "-one", "+ONE", "@@", "-ghost", "+G", "*** End Patch"),
		);
		expect(error.message).toMatch(/hunk 2 of 2/);
		expect(await read("h.txt")).toBe("one\ntwo\n");
	});

	it("refuses a hunk whose context matches but whose removed line does not", async () => {
		await seed("c.txt", "keep\nreal\n");
		await readWithTool("c.txt");
		const error = await applyPatchThrows(
			p("*** Begin Patch", "*** Update File: c.txt", "@@", " keep", "-ghost", "+X", "*** End Patch"),
		);
		expect(error.message).toMatch(/hunk 1 of 1/);
		expect(error.message).toMatch(/-ghost/);
		expect(await read("c.txt")).toBe("keep\nreal\n");
	});
});

describe("apply_patch read state around hostile shapes", () => {
	it("allows the next patch to a moved file at its new path without reading it again", async () => {
		await seed("m1.txt", "one\n");
		await readWithTool("m1.txt");
		expect(
			await applyPatch(p("*** Begin Patch", "*** Update File: m1.txt", "*** Move to: sub/m2.txt", "*** End Patch")),
		).toContain("R m1.txt -> sub/m2.txt");
		expect(
			await applyPatch(p("*** Begin Patch", "*** Update File: sub/m2.txt", "-one", "+TWO", "*** End Patch")),
		).toContain("M sub/m2.txt (+1 -1)");
		expect(await read("sub/m2.txt")).toBe("TWO\n");
	});

	it("lets a later patch add a path it had just deleted", async () => {
		await seed("gone.txt", "x\n");
		await readWithTool("gone.txt");
		await applyPatch(p("*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"));
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: gone.txt", "+new", "*** End Patch"))).toContain(
			"A gone.txt",
		);
		expect(await read("gone.txt")).toBe("new\n");
	});

	it("refuses an Update whose target changed on disk after the read, and does not touch it", async () => {
		await seed("stale.txt", "short\n");
		await readWithTool("stale.txt");
		await writeFile(join(dir, "stale.txt"), "a much longer replacement line\n");
		const error = await applyPatchThrows(
			p("*** Begin Patch", "*** Update File: stale.txt", "-short", "+SHORT", "*** End Patch"),
		);
		expect(error.code).toBe("FILE_STALE");
		expect(await read("stale.txt")).toBe("a much longer replacement line\n");
	});
});

describe("apply_patch progress report", () => {
	it("reports the validated file list once before the result is returned", async () => {
		await seed("b.txt", "one\n");
		await readWithTool("b.txt");
		const seen: string[] = [];
		const definition = createApplyPatchToolDefinition(dir);
		const result = await definition.execute(
			"c",
			{ patch: p("*** Begin Patch", "*** Update File: b.txt", "-one", "+TWO", "*** End Patch") },
			undefined,
			(update) => {
				const details = (update as { details?: { files?: Array<{ path: string }> } })?.details;
				if (details?.files) seen.push(details.files.map((file) => file.path).join(","));
			},
			scope,
		);
		expect(seen).toEqual(["b.txt"]);
		expect((result.content[0] as { text?: string }).text).toContain("M b.txt (+1 -1)");
		expect(await read("b.txt")).toBe("TWO\n");
	});
});
