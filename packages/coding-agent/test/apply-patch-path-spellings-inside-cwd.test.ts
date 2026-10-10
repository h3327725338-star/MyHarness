/**
 * Path spellings an apply_patch text can carry, checked against the tool: which spellings the tool can address
 * at all, which it refuses before touching a byte, and which hostile Windows names it accepts. N06-H2 companion
 * to test/apply-patch.test.ts (normal paths) and test/apply-patch-adversarial-paths.test.ts (same-file
 * collisions, non-regular targets, locator behaviour). Everything runs in a fresh directory under the test temp
 * root (MYHARNESS_TEMP_DIR when the runner sets it); no repository file is touched, and no patch in this file
 * writes through a `\\?\` or UNC spelling - those are only checked where the tool refuses before any write.
 *
 * Behaviour evidence: data/overnight-2026-10-10/h-patch/probe17.ts, probe19.ts, probe20.ts, probe21.ts
 * (scratch probes, run with tsx).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchToolDefinition } from "../src/tools/files/apply-patch.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";

const scope = { sessionManager: { getSessionId: () => "apply-patch-path-spellings" } };
const tempRoot = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();

/** The Windows literal-path prefix, as four characters: \ \ ? \ */
const LITERAL_PREFIX = "\\\\?\\";

let dir: string;

beforeEach(async () => {
	clearFileReadStates();
	dir = await mkdtemp(join(tempRoot, "apply-patch-path-spellings-"));
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

function entries(): Promise<string[]> {
	return readdir(dir);
}

async function readWithTool(relative: string): Promise<void> {
	await createReadToolDefinition(dir).execute("read-1", { path: relative }, undefined, undefined, scope);
}

/** Run a patch and return its result text, or "THROW:<message>" when the tool refuses it. */
async function applyPatch(patchText: string): Promise<string> {
	try {
		const result = await createApplyPatchToolDefinition(dir).execute(
			"c",
			{ patch: patchText },
			undefined,
			undefined,
			scope,
		);
		return (result.content[0] as { text?: string }).text ?? "";
	} catch (error) {
		return `THROW:${(error as Error).message}`;
	}
}

describe("apply_patch spellings that name the working directory itself", () => {
	it("refuses to Add ., .., the bare @ marker and the working directory given as an absolute path", async () => {
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: .", "+x", "*** End Patch"))).toMatch(
			/THROW:Could not add \.: the file already exists/,
		);
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: ..", "+x", "*** End Patch"))).toMatch(
			/THROW:Could not add \.\.: the file already exists/,
		);
		// "@" is stripped as the tool's own path marker, leaving the working directory.
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: @", "+x", "*** End Patch"))).toMatch(
			/THROW:Could not add @: the file already exists/,
		);
		const absoluteCwd = dir.replace(/\\/g, "/");
		expect(await applyPatch(p("*** Begin Patch", `*** Add File: ${absoluteCwd}`, "+x", "*** End Patch"))).toMatch(
			/THROW:Could not add .*: the file already exists/,
		);
		expect(await entries()).toEqual([]);
	});

	it("refuses to Delete or Update . and .. instead of removing or rewriting the working directory", async () => {
		await writeFile(join(dir, "keep.txt"), "x\n");
		expect(await applyPatch(p("*** Begin Patch", "*** Delete File: .", "*** End Patch"))).toMatch(
			/does not exist or is not a regular file/,
		);
		expect(await applyPatch(p("*** Begin Patch", "*** Delete File: ..", "*** End Patch"))).toMatch(
			/does not exist or is not a regular file/,
		);
		expect(await applyPatch(p("*** Begin Patch", "*** Update File: .", "-x", "+y", "*** End Patch"))).toMatch(
			/does not exist or is not a regular file/,
		);
		expect(await read("keep.txt")).toBe("x\n");
		expect(await entries()).toEqual(["keep.txt"]);
	});

	it("refuses an Add whose path is blank, and one that names the drive root", async () => {
		expect(await applyPatch(p("*** Begin Patch", "*** Add File:     ", "+x", "*** End Patch"))).toMatch(
			/must be followed by a file path/,
		);
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: C:/", "+x", "*** End Patch"))).toMatch(
			/THROW:Could not add C:\/: the file already exists/,
		);
		expect(await entries()).toEqual([]);
	});
});

describe("apply_patch spellings that name another volume or a share", () => {
	it("refuses a literal-prefix, other-drive and UNC target that is not an existing regular file, and writes nothing", async () => {
		// These are refused by the regular-file check before any write, so no byte is ever sent to a
		// `\\?\` or UNC spelling here.
		const literalMissing = `${LITERAL_PREFIX}${join(dir, "nope.txt")}`;
		expect(
			await applyPatch(p("*** Begin Patch", `*** Update File: ${literalMissing}`, "-x", "+y", "*** End Patch")),
		).toMatch(/does not exist or is not a regular file/);
		expect(await applyPatch(p("*** Begin Patch", `*** Delete File: ${literalMissing}`, "*** End Patch"))).toMatch(
			/does not exist or is not a regular file/,
		);
		expect(
			await applyPatch(p("*** Begin Patch", "*** Update File: D:\\n06-nope.txt", "-x", "+y", "*** End Patch")),
		).toMatch(/does not exist or is not a regular file/);
		expect(
			await applyPatch(
				p(
					"*** Begin Patch",
					"*** Update File: \\\\n06-invalid.invalid\\share\\nope.txt",
					"-x",
					"+y",
					"*** End Patch",
				),
			),
		).toMatch(/does not exist or is not a regular file/);
		expect(await entries()).toEqual([]);
	});

	it("writes a drive-relative spelling (C:foo) into the working directory, not onto the drive root", async () => {
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: C:dr.txt", "+x", "*** End Patch"))).toContain(
			"A C:dr.txt",
		);
		expect(await entries()).toEqual(["dr.txt"]);
		expect(await read("dr.txt")).toBe("x\n");
	});
});

describe("apply_patch spellings inside the working directory", () => {
	it("accepts an absolute path under the working directory and applies the read gate to it", async () => {
		const absolute = join(dir, "abs.txt").replace(/\\/g, "/");
		expect(await applyPatch(p("*** Begin Patch", `*** Add File: ${absolute}`, "+one", "*** End Patch"))).toContain(
			`A ${absolute}`,
		);
		expect(await read("abs.txt")).toBe("one\n");

		// The same spelling again is refused as already existing, and says to use an Update section.
		expect(await applyPatch(p("*** Begin Patch", `*** Add File: ${absolute}`, "+two", "*** End Patch"))).toMatch(
			/the file already exists\. Use an \*\*\* Update File section/,
		);

		// Never read under this spelling: the read gate refuses the Update.
		clearFileReadStates();
		expect(
			await applyPatch(p("*** Begin Patch", `*** Update File: ${absolute}`, "-one", "+ONE", "*** End Patch")),
		).toMatch(/THROW:Could not edit .* the file was not read in this Session/);
		expect(await read("abs.txt")).toBe("one\n");
		await readWithTool(absolute);
		expect(
			await applyPatch(p("*** Begin Patch", `*** Update File: ${absolute}`, "-one", "+ONE", "*** End Patch")),
		).toContain(`M ${absolute} (+1 -1)`);
		expect(await read("abs.txt")).toBe("ONE\n");
	});

	it("accepts a path that steps out of a subdirectory and back in (sub/../x.txt)", async () => {
		await mkdir(join(dir, "sub"), { recursive: true });
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: sub/../kept.txt", "+x", "*** End Patch"))).toContain(
			"A sub/../kept.txt",
		);
		expect(await read("kept.txt")).toBe("x\n");
		expect((await entries()).sort()).toEqual(["kept.txt", "sub"]);
	});

	it("accepts the absolute spelling of a file the read tool saw under the relative spelling", async () => {
		await writeFile(join(dir, "one.txt"), "a\n");
		await readWithTool("one.txt");
		const absolute = join(dir, "one.txt").replace(/\\/g, "/");
		// The gate is keyed by resolved path, so the absolute spelling of a read file is still readable.
		expect(
			await applyPatch(p("*** Begin Patch", `*** Update File: ${absolute}`, "-a", "+A", "*** End Patch")),
		).toContain(`M ${absolute} (+1 -1)`);
		expect(await read("one.txt")).toBe("A\n");
	});
});

describe("apply_patch Windows file-name aliases and reserved names", () => {
	it("writes dot.txt. and dot.txt as two separate entries, each reachable only by its own spelling", async () => {
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: alias.txt.", "+one", "*** End Patch"))).toContain(
			"A alias.txt.",
		);
		expect(await read("alias.txt.")).toBe("one\n");
		await expect(read("alias.txt")).rejects.toThrow(/ENOENT/);

		// The plain spelling is a different file for the tool's "already exists" and "same file" checks.
		expect(await applyPatch(p("*** Begin Patch", "*** Add File: alias.txt", "+two", "*** End Patch"))).toContain(
			"A alias.txt",
		);
		expect((await entries()).sort()).toEqual(["alias.txt", "alias.txt."]);
		expect(await read("alias.txt")).toBe("two\n");
		expect(await read("alias.txt.")).toBe("one\n");
	});

	it("refuses the trailing-space spelling of a name, because the parser trims it onto the plain name", async () => {
		expect(
			await applyPatch(
				p("*** Begin Patch", "*** Add File: sp.txt", "+one", "*** Add File: sp.txt ", "+two", "*** End Patch"),
			),
		).toMatch(/THROW:.*sp\.txt is the same file as sp\.txt/);
		expect(await entries()).toEqual([]);
	});

	it("creates a Windows reserved device name as a real file entry that the read tool can read back", async () => {
		for (const name of ["CON", "NUL", "AUX"]) {
			expect(await applyPatch(p("*** Begin Patch", `*** Add File: ${name}`, "+payload", "*** End Patch"))).toContain(
				`A ${name}`,
			);
		}
		expect((await entries()).sort()).toEqual(["AUX", "CON", "NUL"]);
		const info = await stat(join(dir, "CON"));
		expect(info.isFile()).toBe(true);
		expect(await readFile(join(dir, "CON"), "utf8")).toBe("payload\n");
		await readWithTool("CON");
		expect(
			await applyPatch(p("*** Begin Patch", "*** Update File: CON", "-payload", "+other", "*** End Patch")),
		).toContain("M CON (+1 -1)");
	});

	it("fails an NTFS stream name at the write step and says the patch could not finish", async () => {
		const result = await applyPatch(
			p("*** Begin Patch", "*** Add File: base.txt:secret", "+payload", "*** End Patch"),
		);
		expect(result).toMatch(/THROW:apply_patch could not finish/);
		expect(result).toMatch(/Not written: create base\.txt:secret/);
	});
});
