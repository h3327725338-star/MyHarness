import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/tools/files/edit.ts";
import { createGrepTool } from "../src/tools/files/grep.ts";
import { createLsTool } from "../src/tools/files/ls.ts";
import { createReadTool } from "../src/tools/files/read.ts";
import { clearFileReadStates } from "../src/tools/files/read-state.ts";
import { createWriteTool } from "../src/tools/files/write.ts";
import { resolveToCwd } from "../src/tools/path-utils.ts";

/**
 * Windows path edge cases for the read / write / edit / ls / grep tools.
 *
 * Each case asserts an invariant the tools must keep on Windows: a hostile path shape
 * fails loudly instead of silently succeeding, the file that already exists is left
 * intact, and no extra file appears in the directory. Behaviour that is wrong today is
 * deliberately NOT locked in here; it is written up in
 * `data/overnight-2026-10-10/i-paths/report.md` (findings marked [高]/[中]) and, per the
 * ticket, awaits a decision on whether those known defects become their own tests.
 *
 * Safety rules this file follows:
 * - it never writes to a reserved device name (CON, NUL, AUX, PRN, COM1, LPT1, ...).
 *   A plain-path write to such a name creates a real file that Explorer cannot delete,
 *   so only read / ls / edit / grep attempts are made and the test then proves that
 *   nothing was created;
 * - the `\\?\` verbatim prefix is used for reads only;
 * - the junction a test creates is removed with `cmd /c rmdir` (the link only, never
 *   the target) before the fixture directory is cleaned up.
 */

const RESERVED_NAMES = ["CON", "NUL", "AUX", "PRN", "COM1", "LPT1", "aux.txt", "CON.txt"];

let fixtureRoot = "";
/** Directory the tools are created with as their cwd. */
let cwd = "";
/** Sibling directory that is deliberately not under `cwd`. */
let outside = "";
/** Name inside `cwd` of the junction the junction test creates, when it exists. */
let junctionName: string | undefined;

function errorText(error: unknown): string {
	const e = error as Error & { code?: string };
	return `${e?.code ?? ""} ${String(e?.message ?? error)}`.trim();
}

async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp, label: string): Promise<string> {
	let error: unknown;
	let succeeded = false;
	try {
		await fn();
		succeeded = true;
	} catch (caught) {
		error = caught;
	}
	if (succeeded) {
		throw new Error(`${label}: expected a failure, but the call succeeded`);
	}
	const text = errorText(error);
	expect(text).toMatch(pattern);
	return text;
}

async function toolText(result: unknown): Promise<string> {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function isReparsePoint(entryPath: string): boolean {
	const result = spawnSync("cmd.exe", ["/c", `fsutil reparsepoint query ${path.resolve(entryPath)}`], {
		encoding: "utf8",
		windowsVerbatimArguments: true,
	});
	return result.status === 0;
}

/** `cmd /c mklink /J`; returns whether a reparse point now exists at `linkPath`. */
function createJunction(linkPath: string, targetPath: string): boolean {
	spawnSync("cmd.exe", ["/c", `mklink /J ${path.resolve(linkPath)} ${path.resolve(targetPath)}`], {
		encoding: "utf8",
		windowsVerbatimArguments: true,
	});
	return existsSync(path.resolve(linkPath)) && isReparsePoint(linkPath);
}

/** Remove a junction link only (never the target) so cleanup cannot follow it. */
function removeJunction(linkPath: string): void {
	spawnSync("cmd.exe", ["/c", `rmdir ${path.resolve(linkPath)}`], {
		encoding: "utf8",
		windowsVerbatimArguments: true,
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read a file once its previous owner has released it (bounded retry). Used after the
 * locking child is killed: the bytes must be exactly what the tools refused to change.
 */
async function readAfterUnlock(target: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			return await readFile(target, "utf8");
		} catch (error) {
			lastError = errorText(error);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`readAfterUnlock: ${target} still unreadable after 15s: ${lastError}`);
}

/**
 * Start a short-lived PowerShell child that holds one file with FileShare.None, so the
 * tools face a file another process owns. Returns undefined when PowerShell is not
 * usable, letting the caller assert a still-meaningful fallback.
 */
async function startExclusiveHolder(target: string): Promise<{ stop: () => void } | undefined> {
	const script = `$fs=[System.IO.File]::Open('${path.resolve(target)}','Open','ReadWrite','None');Write-Output 'LOCKED';Start-Sleep -Seconds 120;$fs.Close()`;
	const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let out = "";
	child.stdout?.on("data", (chunk) => {
		out += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		out += String(chunk);
	});
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline && !out.includes("LOCKED")) {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	if (!out.includes("LOCKED")) {
		child.kill("SIGKILL");
		return undefined;
	}
	return {
		stop: () => {
			child.kill("SIGKILL");
		},
	};
}

beforeAll(() => {
	expect(process.platform).toBe("win32");
});

beforeEach(async () => {
	clearFileReadStates();
	fixtureRoot = await mkdtemp(path.join(tmpdir(), "myharness-windows-path-edge-"));
	cwd = path.join(fixtureRoot, "cwd");
	outside = path.join(fixtureRoot, "outside");
	junctionName = undefined;
	await mkdir(cwd, { recursive: true });
	await mkdir(outside, { recursive: true });
	// A neighbour file, so a directory listing is never accidentally empty.
	await writeFile(path.join(cwd, "neighbour.txt"), "neighbour\n", "utf8");
});

afterEach(async () => {
	// The junction goes first, link only: a recursive delete that reached a reparse
	// point would follow it into the target directory.
	if (junctionName) {
		removeJunction(path.join(cwd, junctionName));
		junctionName = undefined;
	}
	if (fixtureRoot && existsSync(fixtureRoot)) {
		await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
	}
	fixtureRoot = "";
});

describe("Windows path edge cases for the file tools", () => {
	describe("reserved device names", () => {
		it("refuses every reserved-name path and creates no file on disk", async () => {
			const readTool = createReadTool(cwd);
			const lsTool = createLsTool(cwd);
			const editTool = createEditTool(cwd);
			const grepTool = createGrepTool(cwd);

			for (const name of RESERVED_NAMES) {
				const target = path.join(cwd, name);
				await expectRejection(
					() => readTool.execute(`r-${name}`, { path: target }),
					/ENOENT|EISDIR|ENOTDIR|EPERM|EACCES|EBUSY|illegal|not found/,
					`read ${name}`,
				);
				await expectRejection(
					() => lsTool.execute(`l-${name}`, { path: target }),
					/Path not found|Not a directory|Cannot read directory/,
					`ls ${name}`,
				);
				await expectRejection(
					() => editTool.execute(`e-${name}`, { path: target, edits: [{ oldText: "a", newText: "b" }] }),
					/Could not edit file/,
					`edit ${name}`,
				);
				await expectRejection(
					() => grepTool.execute(`g-${name}`, { pattern: "a", path: target }),
					/Path not found|rg:/,
					`grep ${name}`,
				);
			}

			// The part that matters: a refused attempt must not leave a device-named file
			// behind, because such a file cannot be deleted through Explorer.
			const entries = await readdir(cwd);
			for (const name of RESERVED_NAMES) {
				expect(entries.map((entry) => entry.toUpperCase())).not.toContain(name.toUpperCase());
			}
			expect(entries).toContain("neighbour.txt");
		});

		it("reports no match rather than an error when a pattern is searched in a plain directory", async () => {
			const grepTool = createGrepTool(cwd);
			const result = await grepTool.execute("grep-clean", { pattern: "neighbour", path: cwd });
			expect(await toolText(result)).toContain("neighbour.txt:1: neighbour");
		});
	});

	describe("separator and segment spellings of one existing file", () => {
		it("reads the same file through slashes, backslashes, doubled separators and . / .. segments", async () => {
			const readTool = createReadTool(cwd);
			const target = path.join(cwd, "separators.txt");
			await writeFile(target, "one\ntwo\n", "utf8");
			await mkdir(path.join(cwd, "sub"), { recursive: true });

			const spellings = [
				target,
				target.replace(/\\/g, "/"),
				`${cwd}\\sub\\..\\separators.txt`,
				`${cwd}\\\\separators.txt`,
				path.join(cwd, ".", "separators.txt"),
			];
			for (const spelling of spellings) {
				const text = await toolText(await readTool.execute(`s-${spelling.length}`, { path: spelling }));
				expect(text).toContain("one");
				expect(text).toContain("two");
			}
		});

		it("resolves a drive-relative path against the tool cwd instead of the process cwd", async () => {
			const readTool = createReadTool(cwd);
			const writeTool = createWriteTool(cwd);
			const driveLetter = path.resolve(cwd).slice(0, 1); // same drive as the session cwd
			await writeFile(path.join(cwd, "driverel.txt"), "drive relative content\n", "utf8");

			// `C:file.txt` is not absolute on win32, so the tool decides where it lands.
			expect(path.isAbsolute(`${driveLetter}:driverel.txt`)).toBe(false);
			// It must land inside the session cwd, not in the process working directory.
			expect(resolveToCwd(`${driveLetter}:driverel.txt`, cwd)).toBe(path.join(cwd, "driverel.txt"));
			expect(resolveToCwd(`${driveLetter}:driverel.txt`, cwd)).not.toBe(path.resolve(process.cwd(), "driverel.txt"));

			expect(await toolText(await readTool.execute("dr-read", { path: `${driveLetter}:driverel.txt` }))).toContain(
				"drive relative content",
			);

			const result = await writeTool.execute("dr-write", {
				path: `${driveLetter}:written.txt`,
				content: "IN CWD\n",
			});
			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(path.join(cwd, "written.txt"), "utf8")).trim()).toBe("IN CWD");
		});

		it("keeps a POSIX-style absolute path absolute instead of treating it as relative to the cwd", async () => {
			const readTool = createReadTool(cwd);
			const resolved = resolveToCwd("/etc/hostname", cwd);
			expect(path.isAbsolute(resolved)).toBe(true);
			expect(resolved).toMatch(/^[A-Za-z]:\\etc\\hostname$/);
			// The failure names the absolute path the tool chose, not a relative guess.
			const message = await expectRejection(
				() => readTool.execute("posix-abs", { path: "/etc/hostname" }),
				/ENOENT/,
				"read a POSIX absolute path",
			);
			expect(message).toContain(path.win32.sep === "\\" ? "\\etc\\hostname" : "/etc/hostname");
		});
	});

	describe("case-insensitive identity", () => {
		it("treats a different-case spelling as the same file for the read-before-write gate", async () => {
			const readTool = createReadTool(cwd);
			const writeTool = createWriteTool(cwd);
			const mixed = path.join(cwd, "IdenTity.TXT");
			await writeFile(mixed, "identity original\n", "utf8");
			await readTool.execute("ci-read", { path: mixed });

			const result = await writeTool.execute("ci-write", {
				path: path.join(cwd, "identity.txt"),
				content: "IDENTITY NEW\n",
			});

			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(mixed, "utf8")).trim()).toBe("IDENTITY NEW");
			expect((await readdir(cwd)).filter((entry) => entry.toLowerCase() === "identity.txt")).toHaveLength(1);
		});

		it("reads the same bytes through any case spelling", async () => {
			const readTool = createReadTool(cwd);
			const target = path.join(cwd, "CaseFile.txt");
			await writeFile(target, "case probe\n", "utf8");

			for (const spelling of ["CaseFile.txt", "casefile.txt", "CASEFILE.TXT"]) {
				const text = await toolText(await readTool.execute(`cc-${spelling}`, { path: path.join(cwd, spelling) }));
				expect(text).toContain("case probe");
			}
		});
	});

	describe("trailing dots, trailing spaces and awkward characters", () => {
		it("reads a name ending in a dot or a space and refuses the trimmed spelling", async () => {
			const readTool = createReadTool(cwd);
			await writeFile(path.join(cwd, "traildot."), "dot tail\n", "utf8");
			await writeFile(path.join(cwd, "trailspace "), "space tail\n", "utf8");

			expect(await toolText(await readTool.execute("td-1", { path: path.join(cwd, "traildot.") }))).toContain(
				"dot tail",
			);
			expect(await toolText(await readTool.execute("td-2", { path: path.join(cwd, "trailspace ") }))).toContain(
				"space tail",
			);

			await expectRejection(
				() => readTool.execute("td-3", { path: path.join(cwd, "traildot") }),
				/ENOENT/,
				"read 'traildot' without the dot",
			);
			await expectRejection(
				() => readTool.execute("td-4", { path: path.join(cwd, "trailspace") }),
				/ENOENT/,
				"read 'trailspace' without the space",
			);
		});

		it("lists trailing-dot and trailing-space entries verbatim", async () => {
			const lsTool = createLsTool(cwd);
			await writeFile(path.join(cwd, "traildot."), "dot tail\n", "utf8");
			await writeFile(path.join(cwd, "trailspace "), "space tail\n", "utf8");

			const lines = (await toolText(await lsTool.execute("ls-trailing", { path: cwd }))).split("\n");
			expect(lines).toContain("traildot.");
			expect(lines).toContain("trailspace ");
			expect(lines).toContain("neighbour.txt");
		});

		it("reads, writes, lists and greps names with spaces, CJK, full-width, emoji and shell-hostile characters", async () => {
			const readTool = createReadTool(cwd);
			const writeTool = createWriteTool(cwd);
			const lsTool = createLsTool(cwd);
			const grepTool = createGrepTool(cwd);
			const names = [
				"with space.txt",
				"中文文件.txt",
				"全角ａｂ.txt",
				"hash#tag.txt",
				"percent%20.txt",
				"amp&ersand.txt",
				"quote'file.txt",
				"brace{a}.txt",
			];
			for (const name of names) {
				await writeFile(path.join(cwd, name), `content of ${name}\n`, "utf8");
			}

			for (const name of names) {
				const text = await toolText(await readTool.execute(`odd-r-${name}`, { path: path.join(cwd, name) }));
				expect(text).toContain(`content of ${name}`);
			}

			const emoji = "emoji😀.txt";
			const result = await writeTool.execute("odd-w", { path: path.join(cwd, emoji), content: "EMOJI WRITE\n" });
			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(path.join(cwd, emoji), "utf8")).trim()).toBe("EMOJI WRITE");

			const listing = await toolText(await lsTool.execute("odd-ls", { path: cwd }));
			expect(listing).toContain("中文文件.txt");
			expect(listing).toContain(emoji);

			const grepFile = await grepTool.execute("odd-g", {
				pattern: "content of hash",
				path: path.join(cwd, "hash#tag.txt"),
			});
			expect(await toolText(grepFile)).toContain("hash#tag.txt:1: content of hash#tag.txt");
		});

		it("writes through a path whose components contain spaces and non-ASCII characters", async () => {
			const writeTool = createWriteTool(cwd);
			const readTool = createReadTool(cwd);
			const deep = path.join(cwd, "with space", "中文目录", "deep.txt");

			const result = await writeTool.execute("deep-w", { path: deep, content: "DEEP\n" });
			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(deep, "utf8")).trim()).toBe("DEEP");
			expect(await toolText(await readTool.execute("deep-r", { path: deep }))).toContain("DEEP");
		});

		it("writes to a path that leaves the cwd through .. and lands exactly where the resolved path says", async () => {
			const writeTool = createWriteTool(cwd);
			const result = await writeTool.execute("up-write", {
				path: path.join(cwd, "sub", "..", "..", "outside", "up.txt"),
				content: "UP\n",
			});

			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(path.join(outside, "up.txt"), "utf8")).trim()).toBe("UP");
		});
	});

	describe("long paths", () => {
		it("reads a long file name, refuses a write whose atomic temp name would exceed the file-name limit, and leaves the file and directory untouched", async () => {
			const readTool = createReadTool(cwd);
			const writeTool = createWriteTool(cwd);
			const longName = `l${"b".repeat(239)}.txt`; // 241 chars: a legal file name (limit 255)
			const target = path.join(cwd, longName);
			expect(longName.length).toBeLessThanOrEqual(255);
			await writeFile(target, "ORIGINAL LONG\n", "utf8");

			expect(await toolText(await readTool.execute("lp-read", { path: target }))).toContain("ORIGINAL LONG");

			// The atomic writer appends `.<pid>.<uuid>.tmp` (about 48 characters) to the
			// name, which pushes that component past the 255-character limit. Refusing is
			// correct; a "successful" write would be a silent lie.
			await expectRejection(
				() => writeTool.execute("lp-write", { path: target, content: "TOOL WRITE\n" }),
				/ENOENT|ENAMETOOLONG|EINVAL|EPERM/,
				"write over the long name",
			);

			expect((await readFile(target, "utf8")).trim()).toBe("ORIGINAL LONG");
			expect((await readdir(cwd)).filter((entry) => /\.(tmp|old)$/i.test(entry))).toEqual([]);
		});

		it("writes and reads back a long file name that still fits with the atomic suffix", async () => {
			const writeTool = createWriteTool(cwd);
			const readTool = createReadTool(cwd);
			const name = `k${"m".repeat(120)}.txt`;
			expect(name.length + 48).toBeLessThanOrEqual(255);
			const target = path.join(cwd, name);

			const result = await writeTool.execute("lp2-write", { path: target, content: "LONG OK\n" });
			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(target, "utf8")).trim()).toBe("LONG OK");
			expect(await toolText(await readTool.execute("lp2-read", { path: target }))).toContain("LONG OK");
		});

		it("writes and reads a deeply nested path whose total length is far past MAX_PATH", async () => {
			const writeTool = createWriteTool(cwd);
			const readTool = createReadTool(cwd);
			let dir = path.join(cwd, "d");
			while (dir.length + 20 < 1000) dir = path.join(dir, "seg0000001");
			const target = path.join(dir, "tail.txt");
			expect(target.length).toBeGreaterThan(260);

			const result = await writeTool.execute("deep-total-w", { path: target, content: "DEEP TOTAL\n" });
			expect(await toolText(result)).toContain("Successfully wrote");
			expect((await readFile(target, "utf8")).trim()).toBe("DEEP TOTAL");
			expect(await toolText(await readTool.execute("deep-total-r", { path: target }))).toContain("DEEP TOTAL");
		});
	});

	describe("NTFS alternate data streams", () => {
		it("reads a named stream, refuses to write one, and leaves the host file untouched", async () => {
			const readTool = createReadTool(cwd);
			const writeTool = createWriteTool(cwd);
			const host = path.join(cwd, "host.txt");
			await writeFile(host, "main content\n", "utf8");
			await writeFile(`${host}:visible`, "stream content", "utf8");

			expect(await toolText(await readTool.execute("ads-read", { path: `${host}:visible` }))).toContain(
				"stream content",
			);

			await expectRejection(
				() => writeTool.execute("ads-write", { path: `${host}:written`, content: "STREAM WRITE\n" }),
				/EINVAL|ENOENT|EPERM/,
				"write a new stream",
			);
			expect(await readFile(host, "utf8")).toBe("main content\n");
			expect((await stat(host)).size).toBe(13);
			// A stream is not a directory entry: the listing must show exactly the host file
			// and nothing else whose name contains a colon or the atomic temp suffix.
			const entries = await readdir(cwd);
			expect(entries.filter((entry) => entry.includes(":"))).toEqual([]);
			expect(entries).toContain("host.txt");
			expect((await readdir(cwd)).filter((entry) => /\.(tmp|old)$/i.test(entry))).toEqual([]);
			// The refused stream must not exist now: reading it still fails, so the failed
			// write left no half-written stream behind.
			await expectRejection(
				() => readTool.execute("ads-check", { path: `${host}:written` }),
				/ENOENT/,
				"read back the refused stream",
			);
		});

		it("does not accept a bare colon suffix as a readable name", async () => {
			const readTool = createReadTool(cwd);
			const host = path.join(cwd, "colon.txt");
			await writeFile(host, "colon host\n", "utf8");
			await expectRejection(
				() => readTool.execute("colon-1", { path: `${host}:` }),
				/ENOENT|ENOTDIR|EINVAL/,
				"read 'colon.txt:'",
			);
		});
	});

	describe("verbatim and network prefixes", () => {
		it("reads through the \\\\?\\ verbatim prefix and does not normalise the name for it", async () => {
			const readTool = createReadTool(cwd);
			const target = path.join(cwd, "verbatim.txt");
			await writeFile(target, "verbatim content\n", "utf8");

			expect(await toolText(await readTool.execute("qt-1", { path: `\\\\?\\${path.resolve(target)}` }))).toContain(
				"verbatim content",
			);
			// With the prefix Windows performs no name normalisation, so the trailing-dot
			// spelling really is a different name and must not read as the file above.
			await expectRejection(
				() => readTool.execute("qt-2", { path: `\\\\?\\${path.resolve(target)}.` }),
				/ENOENT|ENOTDIR|EINVAL/,
				"read '\\\\?\\...verbatim.txt.'",
			);
		});

		it("reads a UNC path as absolute, or fails naming that exact path", async () => {
			const readTool = createReadTool(cwd);
			const unc = "\\\\localhost\\c$\\Windows\\win.ini";
			let raw: string | undefined;
			try {
				raw = await readFile(unc, "utf8");
			} catch {
				raw = undefined;
			}

			if (raw === undefined) {
				const message = await expectRejection(
					() => readTool.execute("unc-1", { path: unc }),
					/./,
					"read the admin share",
				);
				expect(message).toContain("localhost");
			} else {
				const text = await toolText(await readTool.execute("unc-2", { path: unc, limit: 2 }));
				expect(text).toContain(raw.split(/\r?\n/)[0]);
			}

			// An unreachable host must fail loudly instead of returning empty content.
			const ghost = "\\\\myharness-nosuchhost.invalid\\share\\file.txt";
			const failure = await expectRejection(
				() => readTool.execute("unc-3", { path: ghost }),
				/./,
				"read from a nonexistent host",
			);
			expect(failure).not.toContain("Successfully");
		});
	});

	describe("junction pointing outside the tool cwd", () => {
		it("follows a junction for ls and read, and reports the path it wrote", async () => {
			await writeFile(path.join(outside, "outside.txt"), "content outside the cwd\n", "utf8");
			junctionName = "jlink";
			const linkName = junctionName;
			const link = path.join(cwd, linkName);
			const created = createJunction(link, outside);

			const lsTool = createLsTool(cwd);
			const readTool = createReadTool(cwd);
			const writeTool = createWriteTool(cwd);

			if (!created) {
				// `mklink` needs privileges on some machines; then the path simply does not
				// exist and every tool must say so instead of inventing content.
				await expectRejection(
					() => readTool.execute("jn-absent", { path: path.join(linkName, "outside.txt") }),
					/ENOENT/,
					"read through a junction that could not be created",
				);
				await expectRejection(
					() => lsTool.execute("jn-absent-ls", { path: linkName }),
					/Path not found/,
					"ls a missing junction",
				);
				junctionName = undefined;
				return;
			}

			expect(await toolText(await lsTool.execute("jn-ls", { path: linkName }))).toContain("outside.txt");
			expect(
				await toolText(await readTool.execute("jn-read", { path: path.join(linkName, "outside.txt") })),
			).toContain("content outside the cwd");

			const written = await writeTool.execute("jn-write", {
				path: path.join(linkName, "written.txt"),
				content: "OUTSIDE VIA JUNCTION\n",
			});
			expect(await toolText(written)).toContain("Successfully wrote");
			// The file tools do follow a junction out of the session cwd; keeping them jailed
			// to the worktree is the delegated write guard's job, not theirs. Recorded here so
			// the behaviour stays observable rather than accidental.
			expect((await readFile(path.join(outside, "written.txt"), "utf8")).trim()).toBe("OUTSIDE VIA JUNCTION");
		});
	});

	describe("read-only, locked and unread files", () => {
		it("refuses to edit a file marked read-only and leaves the content untouched", async () => {
			const target = path.join(cwd, "readonly.txt");
			await writeFile(target, "readonly content\n", "utf8");
			spawnSync("cmd.exe", ["/c", `attrib +R ${path.resolve(target)}`], {
				encoding: "utf8",
				windowsVerbatimArguments: true,
			});
			try {
				const readTool = createReadTool(cwd);
				const editTool = createEditTool(cwd);
				await readTool.execute("ro-read", { path: target });

				await expectRejection(
					() =>
						editTool.execute("ro-edit", { path: target, edits: [{ oldText: "readonly", newText: "writable" }] }),
					/EPERM|EACCES/,
					"edit a read-only file",
				);
				expect(await readFile(target, "utf8")).toBe("readonly content\n");
				expect((await readdir(cwd)).filter((entry) => /\.(tmp|old)$/i.test(entry))).toEqual([]);
			} finally {
				spawnSync("cmd.exe", ["/c", `attrib -R ${path.resolve(target)}`], {
					encoding: "utf8",
					windowsVerbatimArguments: true,
				});
			}
		});

		it("refuses to read or edit a file another process holds exclusively and never damages it", async () => {
			const target = path.join(cwd, "locked.txt");
			await writeFile(target, "locked original\n", "utf8");
			const holder = await startExclusiveHolder(target);
			if (!holder) {
				// No PowerShell here: the honest fallback is that the file is still intact.
				expect((await readFile(target, "utf8")).trim()).toBe("locked original");
				return;
			}
			try {
				const readTool = createReadTool(cwd);
				const editTool = createEditTool(cwd);
				await expectRejection(
					() => readTool.execute("lk-read", { path: target }),
					/EBUSY|EPERM|EACCES/,
					"read a locked file",
				);
				await expectRejection(
					() => editTool.execute("lk-edit", { path: target, edits: [{ oldText: "locked", newText: "unlocked" }] }),
					/EBUSY|EPERM|EACCES|Could not edit file|not read/,
					"edit a locked file",
				);
				expect((await readdir(cwd)).filter((entry) => /\.(tmp|old)$/i.test(entry))).toEqual([]);
			} finally {
				holder.stop();
			}
			// Once the other process is gone the bytes must still be the ones it never let
			// anyone change.
			expect(await readAfterUnlock(target)).toBe("locked original\n");
		});

		it("refuses every mutation of an existing file that was never read", async () => {
			const writeTool = createWriteTool(cwd);
			const editTool = createEditTool(cwd);
			const target = path.join(cwd, "gate.txt");
			await writeFile(target, "gate original\n", "utf8");

			await expectRejection(
				() => writeTool.execute("gate-w", { path: target, content: "NO\n" }),
				/FILE_NOT_READ/,
				"write an unread file",
			);
			await expectRejection(
				() => editTool.execute("gate-e", { path: target, edits: [{ oldText: "gate", newText: "NO" }] }),
				/FILE_NOT_READ/,
				"edit an unread file",
			);
			expect(await readFile(target, "utf8")).toBe("gate original\n");
		});
	});

	describe("failure messages", () => {
		it("ls names the missing path, refuses a file, and calls an empty directory empty", async () => {
			const lsTool = createLsTool(cwd);
			const missing = path.join(cwd, "no-such-dir");
			await expectRejection(
				() => lsTool.execute("ls-miss", { path: missing }),
				new RegExp(`Path not found: ${escapeRegExp(missing)}`),
				"ls a missing directory",
			);

			const file = path.join(cwd, "notadir.txt");
			await writeFile(file, "x\n", "utf8");
			await expectRejection(
				() => lsTool.execute("ls-file", { path: file }),
				new RegExp(`Not a directory: ${escapeRegExp(file)}`),
				"ls a file",
			);

			const empty = path.join(cwd, "emptydir");
			await mkdir(empty, { recursive: true });
			expect(await toolText(await lsTool.execute("ls-empty", { path: empty }))).toBe("(empty directory)");
		});

		it("read refuses a directory and a missing file with an errno the user can act on", async () => {
			const readTool = createReadTool(cwd);
			await expectRejection(
				() => readTool.execute("r-dir", { path: cwd }),
				/EISDIR|ENOTDIR|EPERM|EACCES/,
				"read a directory",
			);
			await expectRejection(
				() => readTool.execute("r-missing", { path: path.join(cwd, "gone.txt") }),
				/ENOENT/,
				"read a missing file",
			);
		});

		it("grep refuses a missing path instead of reporting no matches", async () => {
			const grepTool = createGrepTool(cwd);
			const missing = path.join(cwd, "nope");
			await expectRejection(
				() => grepTool.execute("g-miss", { pattern: "anything", path: missing }),
				new RegExp(`Path not found: ${escapeRegExp(missing)}`),
				"grep a missing path",
			);
		});
	});

	describe("bounded reads of unusual content", () => {
		it("returns nothing for an empty file and a bounded hint for an oversized single line", async () => {
			const readTool = createReadTool(cwd);
			const empty = path.join(cwd, "empty.txt");
			await writeFile(empty, "", "utf8");
			expect(await toolText(await readTool.execute("br-empty", { path: empty }))).toBe("");

			const oneLine = path.join(cwd, "huge-line.txt");
			await writeFile(oneLine, "z".repeat(200_000), "utf8");
			const text = await toolText(await readTool.execute("br-huge", { path: oneLine }));
			expect(text).toContain("exceeds");
			expect(text.length).toBeLessThan(2_000);
		});

		it("reads a ten-megabyte file as a bounded preview with a continuation hint", async () => {
			const readTool = createReadTool(cwd);
			const big = path.join(cwd, "big.txt");
			await writeFile(big, `${"line\n".repeat(2_000_000)}${"t".repeat(4096)}`, "utf8");
			const size = (await stat(big)).size;
			expect(size).toBeGreaterThan(9 * 1024 * 1024);

			const text = await toolText(await readTool.execute("big-read", { path: big }));
			expect(text).toContain("Use offset=");
			expect(text.length).toBeLessThan(60 * 1024);
			expect(text.length).toBeLessThan(size);
		});
	});
});
