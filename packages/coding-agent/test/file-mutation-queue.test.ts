import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/tools/files/edit.ts";
import { withFileMutationQueue } from "../src/tools/files/file-mutation-queue.ts";
import { createWriteTool } from "../src/tools/files/write.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

const tempDirs: string[] = [];

/**
 * Windows only allows file/directory symlinks when Developer Mode is enabled or
 * the process is elevated; creating one otherwise fails with EPERM. Probe the
 * capability instead of assuming, so the symlink-specific test can be skipped
 * with a real reason while alias coverage still runs through directory
 * junctions, which are unprivileged reparse points on Windows.
 */
function probeCapability(create: (dir: string) => void): boolean {
	const dir = mkdtempSync(join(tmpdir(), "myharness-file-mutation-probe-"));
	try {
		create(dir);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const DIRECTORY_ALIAS_TYPE = process.platform === "win32" ? "junction" : "dir";

const supportsFileSymlinks = probeCapability((dir) => {
	writeFileSync(join(dir, "target.txt"), "probe", "utf8");
	symlinkSync(join(dir, "target.txt"), join(dir, "alias.txt"));
});

const supportsDirectoryAliases = probeCapability((dir) => {
	const realDir = join(dir, "real");
	mkdirSync(realDir);
	writeFileSync(join(realDir, "target.txt"), "probe", "utf8");
	symlinkSync(realDir, join(dir, "alias"), DIRECTORY_ALIAS_TYPE);
	// The mutation queue collapses aliases via realpath, so the probe must confirm
	// realpath actually resolves through the alias.
	if (realpathSync(join(dir, "alias", "target.txt")) !== realpathSync(join(realDir, "target.txt"))) {
		throw new Error("directory alias does not resolve through realpath");
	}
});

async function createDirectoryAlias(target: string, linkPath: string): Promise<void> {
	await symlink(target, linkPath, DIRECTORY_ALIAS_TYPE);
}

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "myharness-file-mutation-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same file", async () => {
		const order: string[] = [];
		const path = "/tmp/file-mutation-queue-same";

		const first = withFileMutationQueue(path, async () => {
			order.push("first:start");
			await delay(30);
			order.push("first:end");
		});
		const second = withFileMutationQueue(path, async () => {
			order.push("second:start");
			order.push("second:end");
		});

		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different files to proceed in parallel", async () => {
		const order: string[] = [];

		await Promise.all([
			withFileMutationQueue("/tmp/file-mutation-queue-a", async () => {
				order.push("a:start");
				await delay(30);
				order.push("a:end");
			}),
			withFileMutationQueue("/tmp/file-mutation-queue-b", async () => {
				order.push("b:start");
				await delay(30);
				order.push("b:end");
			}),
		]);

		expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
	});

	// Requires file-symlink privileges (Developer Mode or elevation on Windows).
	it.skipIf(!supportsFileSymlinks)("uses the same queue for symlink aliases", async () => {
		const dir = await createTempDir();
		const targetPath = join(dir, "target.txt");
		const symlinkPath = join(dir, "alias.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await symlink(targetPath, symlinkPath);

		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			withFileMutationQueue(symlinkPath, async () => {
				order.push("alias:start");
				order.push("alias:end");
			}),
		]);

		expect(order).toEqual(["target:start", "target:end", "alias:start", "alias:end"]);
	});

	// Directory junctions (Windows) and directory symlinks (POSIX) must also map to
	// the same queue key after realpath resolution.
	it.skipIf(!supportsDirectoryAliases)("uses the same queue for directory alias paths", async () => {
		const dir = await createTempDir();
		const realDir = join(dir, "real");
		const aliasDir = join(dir, "alias");
		await mkdir(realDir, { recursive: true });
		const targetPath = join(realDir, "target.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await createDirectoryAlias(realDir, aliasDir);

		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			withFileMutationQueue(join(aliasDir, "target.txt"), async () => {
				order.push("alias:start");
				order.push("alias:end");
			}),
		]);

		expect(order).toEqual(["target:start", "target:end", "alias:start", "alias:end"]);
	});
});

describe("built-in edit and write tools", () => {
	it("preserves both parallel edits on the same file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "parallel-edit.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});

		await Promise.all([
			editTool.execute("call-1", { path: filePath, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
			editTool.execute("call-2", { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] }),
		]);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("ALPHA\nBETA\ngamma\n");
	});

	it("shares the queue between edit and write", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "mixed.txt");
		await writeFile(filePath, "original\n", "utf8");

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});
		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					await delay(10);
					await writeFile(path, content, "utf8");
				},
			},
		});

		const editPromise = editTool.execute("call-1", {
			path: filePath,
			edits: [{ oldText: "original", newText: "edited" }],
		});
		await delay(5);
		const writePromise = writeTool.execute("call-2", {
			path: filePath,
			content: "replacement\n",
		});

		await Promise.all([editPromise, writePromise]);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("replacement\n");
	});

	it("keeps write queue locked while an aborted write is still in flight", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "abort-write.txt");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		const secondWriteStarted = createDeferred();
		let firstWriteSettled = false;

		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					if (content === "first\n") {
						firstWriteStarted.resolve();
						await finishFirstWrite.promise;
						await writeFile(path, content, "utf8");
						firstWriteSettled = true;
						return;
					}

					if (content === "second\n") {
						expect(firstWriteSettled).toBe(true);
						secondWriteStarted.resolve();
					}
					await writeFile(path, content, "utf8");
				},
			},
		});

		const controller = new AbortController();
		const firstWrite = writeTool.execute("call-1", { path: filePath, content: "first\n" }, controller.signal);
		await firstWriteStarted.promise;
		controller.abort();

		const secondWrite = writeTool.execute("call-2", { path: filePath, content: "second\n" });
		expect(await resolvesWithin(secondWriteStarted.promise, 20)).toBe(false);

		finishFirstWrite.resolve();
		await expect(firstWrite).resolves.toMatchObject({
			details: { mutationStatus: "committed-after-cancel" },
		});
		await secondWrite;

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("second\n");
	});

	it("keeps edit queue locked while an aborted edit write is still in flight", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "abort-edit.txt");
		await writeFile(filePath, "alpha\nbeta\n", "utf8");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		const secondWriteStarted = createDeferred();
		let firstWriteSettled = false;

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile,
				writeFile: async (path, content) => {
					if (content === "ALPHA\nbeta\n") {
						firstWriteStarted.resolve();
						await finishFirstWrite.promise;
						await writeFile(path, content, "utf8");
						firstWriteSettled = true;
						return;
					}

					if (content === "ALPHA\nBETA\n" || content === "alpha\nBETA\n") {
						expect(firstWriteSettled).toBe(true);
						secondWriteStarted.resolve();
					}
					await writeFile(path, content, "utf8");
				},
			},
		});

		const controller = new AbortController();
		const firstEdit = editTool.execute(
			"call-1",
			{ path: filePath, edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			controller.signal,
		);
		await firstWriteStarted.promise;
		controller.abort();

		const secondEdit = editTool.execute("call-2", {
			path: filePath,
			edits: [{ oldText: "beta", newText: "BETA" }],
		});
		expect(await resolvesWithin(secondWriteStarted.promise, 20)).toBe(false);

		finishFirstWrite.resolve();
		await expect(firstEdit).resolves.toMatchObject({
			details: { mutationStatus: "committed-after-cancel" },
		});
		await secondEdit;

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("ALPHA\nBETA\n");
	});
});
