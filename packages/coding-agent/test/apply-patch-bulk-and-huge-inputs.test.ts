/**
 * Large and long inputs handed to apply_patch on the normal path: a patch with dozens of file sections, a patch
 * of tens of thousands of lines, a single line of 100k characters, and a hunk that changes nothing. N06-H2
 * companion to test/apply-patch.test.ts (normal shapes at normal size). These pin that the tool finishes and
 * reports honestly when the input is big, without hanging or leaving a half-applied file behind.
 *
 * Everything runs in a fresh directory under the test temp root (MYHARNESS_TEMP_DIR when the runner sets it);
 * no repository file is touched. Timing-sensitive assertions are avoided: the only "size" assertions are about
 * content and reported counts.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApplyPatchToolDetails, createApplyPatchToolDefinition } from "../src/tools/files/apply-patch.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";

const scope = { sessionManager: { getSessionId: () => "apply-patch-bulk-and-huge-inputs" } };
const tempRoot = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();

let dir: string;

beforeEach(async () => {
	clearFileReadStates();
	dir = await mkdtemp(join(tempRoot, "apply-patch-bulk-"));
});

afterEach(async () => {
	clearFileReadStates();
	await rm(dir, { recursive: true, force: true });
});

function p(...lines: string[]): string {
	return lines.join("\n");
}

async function read(relative: string): Promise<string> {
	return readFile(join(dir, relative), "utf8");
}

async function applyPatch(patchText: string): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const result = await createApplyPatchToolDefinition(dir).execute(
		"c",
		{ patch: patchText },
		undefined,
		undefined,
		scope,
	);
	return {
		text: (result.content[0] as { text?: string }).text ?? "",
		details: result.details as ApplyPatchToolDetails | undefined,
	};
}

async function applyPatchError(patchText: string): Promise<Error> {
	try {
		await createApplyPatchToolDefinition(dir).execute("c", { patch: patchText }, undefined, undefined, scope);
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the patch to be refused");
}

async function readWithTool(relative: string): Promise<void> {
	await createReadToolDefinition(dir).execute("read-1", { path: relative }, undefined, undefined, scope);
}

describe("apply_patch with many file sections in one patch", () => {
	it("adds 60 files across 4 directories in one call and reports every one of them", async () => {
		const lines = ["*** Begin Patch"];
		for (let index = 0; index < 60; index++) {
			lines.push(`*** Add File: g${index % 4}/f${index}.txt`, `+content ${index}`);
		}
		lines.push("*** End Patch");

		const { text, details } = await applyPatch(lines.join("\n"));
		expect(text).toContain("Applied patch to 60 file(s):");
		expect(details?.files).toHaveLength(60);
		expect(details?.files?.map((file) => file.path)).toEqual(
			Array.from({ length: 60 }, (_, index) => `g${index % 4}/f${index}.txt`),
		);
		expect(await read("g0/f0.txt")).toBe("content 0\n");
		expect(await read("g3/f59.txt")).toBe("content 59\n");
		expect((await readdir(join(dir, "g2"))).length).toBe(15);
	});

	it("refuses a 60-file patch whose last section collides with an existing file and writes none of them", async () => {
		await mkdir(join(dir, "taken"), { recursive: true });
		const lines = ["*** Begin Patch"];
		for (let index = 0; index < 59; index++) lines.push(`*** Add File: n${index}.txt`, `+content ${index}`);
		lines.push("*** Add File: taken", "+last", "*** End Patch");

		const error = await applyPatchError(lines.join("\n"));
		expect(error.message).toMatch(/Could not add taken: the file already exists/);
		expect(await readdir(dir)).toEqual(["taken"]);
	});
});

describe("apply_patch with a very large patch text", () => {
	it("applies 20 hunks spread over a 20000-line file and leaves the other 19980 lines alone", async () => {
		const total = 20000;
		const body = Array.from({ length: total }, (_, index) => `row ${index}`).join("\n");
		await writeFile(join(dir, "big.txt"), `${body}\n`);
		await readWithTool("big.txt");

		const lines = ["*** Begin Patch", "*** Update File: big.txt"];
		for (let index = 0; index < total; index += 1000) lines.push("@@", `-row ${index}`, `+ROW ${index}`);
		lines.push("*** End Patch");

		const { text, details } = await applyPatch(lines.join("\n"));
		expect(text).toContain(`M big.txt (+${total / 1000} -${total / 1000})`);
		const after = (await read("big.txt")).split("\n");
		expect(after.length).toBe(total + 1);
		expect(after[0]).toBe("ROW 0");
		expect(after[1]).toBe("row 1");
		expect(after[1000]).toBe("ROW 1000");
		expect(after[1001]).toBe("row 1001");
		expect(after[total - 1]).toBe(`row ${total - 1}`);
		expect(details?.files?.[0]?.linesAdded).toBe(total / 1000);
		expect(details?.files?.[0]?.linesRemoved).toBe(total / 1000);
	});

	it("refuses the hunk that does not match in a 20000-line patch and keeps the original file byte for byte", async () => {
		const total = 20000;
		const body = Array.from({ length: total }, (_, index) => `row ${index}`).join("\n");
		await writeFile(join(dir, "big.txt"), `${body}\n`);
		await readWithTool("big.txt");
		const before = await read("big.txt");

		const lines = ["*** Begin Patch", "*** Update File: big.txt", "@@", "-row 0", "+ROW 0"];
		for (let index = 1000; index < total; index += 1000) lines.push("@@", `-row ${index}`, `+ROW ${index}`);
		lines.splice(lines.length - 2, 1, "-row 99999999");
		lines.push("*** End Patch");

		const error = await applyPatchError(lines.join("\n"));
		expect(error.message).toMatch(/Could not apply hunk \d+ of 20 to big\.txt/);
		expect(await read("big.txt")).toBe(before);
	});

	it("replaces a single line of 100000 characters by its exact text", async () => {
		const long = `start ${"k".repeat(100000)} end`;
		await writeFile(join(dir, "long.txt"), `${long}\n`);
		await readWithTool("long.txt");

		const { text } = await applyPatch(
			p("*** Begin Patch", "*** Update File: long.txt", `-${long}`, "+short", "*** End Patch"),
		);
		expect(text).toContain("M long.txt (+1 -1)");
		expect(await read("long.txt")).toBe("short\n");
	});

	it("reports a hunk of context lines only as +0 -0 and leaves the file untouched", async () => {
		await writeFile(join(dir, "ctx.txt"), "one\ntwo\n");
		await readWithTool("ctx.txt");

		const { text, details } = await applyPatch(
			p("*** Begin Patch", "*** Update File: ctx.txt", "@@", " one", " two", "*** End Patch"),
		);
		expect(text).toContain("M ctx.txt (+0 -0)");
		expect(details?.files?.[0]?.linesAdded).toBe(0);
		expect(details?.files?.[0]?.linesRemoved).toBe(0);
		expect(await read("ctx.txt")).toBe("one\ntwo\n");
	});

	it("creates the directories a large patch needs and only those", async () => {
		const lines = ["*** Begin Patch"];
		for (let index = 0; index < 30; index++)
			lines.push(`*** Add File: a${index % 3}/b${index % 5}/c${index}.txt`, `+x${index}`);
		lines.push("*** End Patch");

		await applyPatch(lines.join("\n"));
		expect((await readdir(dir)).sort()).toEqual(["a0", "a1", "a2"]);
		expect(await read("a1/b1/c16.txt")).toBe("x16\n");
	});
});
