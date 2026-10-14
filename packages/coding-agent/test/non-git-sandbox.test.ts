import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionBackgroundWork } from "../src/agent/delegation/background-work.ts";
import * as sandboxModule from "../src/agent/delegation/non-git-sandbox.ts";
import {
	cleanupStaleDelegatedSandboxes,
	type DelegatedSandboxHandle,
	finalizeDelegatedSandbox,
	nonGitMirrorExclusion,
	prepareDelegatedSandbox,
	registerDelegatedSandboxWorker,
} from "../src/agent/delegation/non-git-sandbox.ts";
import { createLsToolDefinition } from "../src/tools/files/ls.ts";
import { createReadToolDefinition } from "../src/tools/files/read.ts";
import { evaluateDelegatedWriteToolCall } from "../src/tools/shell/delegated-write-guard.ts";
import { resolveSubAgentRuntimeSettings, runExploreBatch } from "../src/tools/sub-agent.ts";

const directories: string[] = [];
const handles: DelegatedSandboxHandle[] = [];
async function origin() {
	const path = await mkdtemp(join(tmpdir(), "mirror-fixture-"));
	directories.push(path);
	return path;
}
async function prepare(path: string, options: Parameters<typeof prepareDelegatedSandbox>[0] = { originCwd: path }) {
	const result = await prepareDelegatedSandbox({
		...options,
		originCwd: path,
		onCreated: (handle) => handles.push(handle),
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.handle;
}
afterEach(async () => {
	for (const handle of handles.splice(0)) {
		// Tests which alter ownership restore it before teardown.
		const result = await finalizeDelegatedSandbox(handle);
		expect(result.removed, result.error).toBe(true);
	}
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("non-Git workspace mirrors", () => {
	it("preserves relative Unicode paths and uses independent ordinary files", async () => {
		const path = await origin();
		await mkdir(join(path, "中文 目录"));
		await writeFile(join(path, "中文 目录", "课件.pdf"), Buffer.from([0, 1, 255, 4]));
		await writeFile(join(path, "说明.txt"), "原始正文\r\n");
		const first = await prepare(path);
		const second = await prepare(path);
		expect(first.importedFiles).toBe(2);
		expect(first.complete).toBe(true);
		expect(await readFile(join(first.sandboxPath, "中文 目录", "课件.pdf"))).toEqual(Buffer.from([0, 1, 255, 4]));
		expect((await lstat(join(first.sandboxPath, "说明.txt"))).nlink).toBe(1);
		await writeFile(join(first.sandboxPath, "说明.txt"), "worker edit");
		expect(await readFile(join(path, "说明.txt"), "utf8")).toBe("原始正文\r\n");
		expect(await readFile(join(second.sandboxPath, "说明.txt"), "utf8")).toBe("原始正文\r\n");
		expect(await readdir(path)).not.toContain(".git");
		expect(await finalizeDelegatedSandbox(first)).toEqual({ removed: true });
		expect(await finalizeDelegatedSandbox(first)).toEqual({ removed: true });
	});

	it("allows the actual read and ls tools at sandbox-relative paths without relaxing the guard", async () => {
		const path = await origin();
		await writeFile(join(path, "课件.txt"), "可读课件正文");
		const handle = await prepare(path);
		expect(evaluateDelegatedWriteToolCall("read", { path: "./课件.txt" }, handle.sandboxPath, path)).toBeUndefined();
		const read = await createReadToolDefinition(handle.sandboxPath).execute(
			"read-1",
			{ path: "./课件.txt" },
			undefined,
			undefined,
			undefined,
		);
		expect(read.content).toEqual([{ type: "text", text: "可读课件正文" }]);
		const listing = await createLsToolDefinition(handle.sandboxPath).execute(
			"ls-1",
			{},
			undefined,
			undefined,
			undefined,
		);
		expect(listing.content).toEqual([{ type: "text", text: "课件.txt" }]);
		expect(
			evaluateDelegatedWriteToolCall("write", { path: join(path, "课件.txt") }, handle.sandboxPath, path),
		).toContain("越出");
		expect(
			evaluateDelegatedWriteToolCall(
				"bash",
				{ command: `cat "${join(path, "课件.txt")}"` },
				handle.sandboxPath,
				path,
			),
		).toContain("越出");
		expect(
			evaluateDelegatedWriteToolCall("read", { path: join(path, "课件.txt") }, handle.sandboxPath, path),
		).toBeUndefined();
	});

	it("prunes blacklisted directories at every level and reports filtered secrets", async () => {
		const path = await origin();
		for (const name of ["node_modules", ".cache", "build", "DIST", "target", ".next"]) {
			await mkdir(join(path, "nested", name), { recursive: true });
			await writeFile(join(path, "nested", name, "hidden.txt"), "excluded");
		}
		await writeFile(join(path, ".env"), "SECRET=never copied");
		await writeFile(join(path, ".env.example"), "EXAMPLE=");
		await writeFile(join(path, "normal.json"), "{}");
		const handle = await prepare(path);
		expect(handle.importedFiles).toBe(2);
		expect(await readdir(join(handle.sandboxPath, "nested"))).toEqual([]);
		expect(await readdir(handle.sandboxPath)).not.toContain(".env");
		expect(handle.importNotes.some((note) => note.includes(".env："))).toBe(true);
		expect(nonGitMirrorExclusion("src/building", true)).toBeUndefined();
		expect(nonGitMirrorExclusion("x/.myharness/auth.json", false)).toBeDefined();
	});

	it("skips external junctions and broken links without traversing them", async () => {
		const path = await origin();
		const outside = await origin();
		await writeFile(join(outside, "private.txt"), "outside");
		await symlink(outside, join(path, "external"), process.platform === "win32" ? "junction" : "dir");
		await symlink(join(outside, "missing"), join(path, "broken"), process.platform === "win32" ? "junction" : "dir");
		await writeFile(join(path, "ok.txt"), "ok");
		const handle = await prepare(path);
		expect(await readdir(handle.sandboxPath)).toEqual(["ok.txt"]);
		// Cleanup must unlink a worker-created junction, never its outside target.
		await symlink(
			outside,
			join(handle.sandboxPath, "worker-link"),
			process.platform === "win32" ? "junction" : "dir",
		);
		expect((await finalizeDelegatedSandbox(handle)).removed).toBe(true);
		expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("outside");
	});

	it("reports size/depth limits instead of claiming a complete mirror", async () => {
		const path = await origin();
		await writeFile(join(path, "small.txt"), "ok");
		await writeFile(join(path, "large.txt"), "too large");
		await mkdir(join(path, "a", "b"), { recursive: true });
		await writeFile(join(path, "a", "b", "deep.txt"), "deep");
		const handle = await prepare(path, { originCwd: path, limits: { fileBytes: 4, depth: 1 } });
		expect(handle.complete).toBe(false);
		expect(handle.importedFiles).toBe(1);
		expect(handle.importNotes.some((note) => note.includes("大小预算"))).toBe(true);
		expect(handle.importNotes.some((note) => note.includes("深度预算"))).toBe(true);
	});

	it("cancels assembly and removes the registered partial mirror", async () => {
		const path = await origin();
		await writeFile(join(path, "a.txt"), "a");
		const controller = new AbortController();
		let handle: DelegatedSandboxHandle | undefined;
		const result = await prepareDelegatedSandbox({
			originCwd: path,
			signal: controller.signal,
			onCreated: (created) => {
				handle = created;
				handles.push(created);
				controller.abort();
			},
		});
		expect(result.ok).toBe(false);
		expect(handle).toBeDefined();
		await expect(lstat(handle!.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails closed on an entry budget, and cleans a half-built mirror", async () => {
		const path = await origin();
		await writeFile(join(path, "a"), "a");
		await writeFile(join(path, "b"), "b");
		const result = await prepareDelegatedSandbox({
			originCwd: path,
			limits: { entries: 1 },
			onCreated: (handle) => handles.push(handle),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("目录项");
		await expect(lstat(handles.at(-1)!.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not start a writable worker on the host when mirror preparation fails", async () => {
		const path = await origin();
		const failure = vi
			.spyOn(sandboxModule, "prepareDelegatedSandbox")
			.mockResolvedValue({ ok: false, error: "mirror denied" });
		try {
			const result = await runExploreBatch({
				cwd: path,
				tasks: [{ description: "missing", prompt: "read files" }],
				settings: resolveSubAgentRuntimeSettings({
					enabled: true,
					provider: "fake",
					model: "fake",
					mode: "read-write",
				}),
			});
			expect(result.details.results[0].status).toBe("failed");
			expect(result.details.results[0].toolUseCount).toBe(0);
			expect(result.details.results[0].error).toBe("mirror denied");
		} finally {
			failure.mockRestore();
		}
	});

	it("reclaims a marked sandbox after its parent exits, but refuses a forged token", async () => {
		const path = await origin();
		await writeFile(join(path, "ok"), "ok");
		const handle = await prepare(path);
		expect((await finalizeDelegatedSandbox({ ...handle, token: "forged" })).removed).toBe(false);
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], { windowsHide: true });
		const pid = child.pid!;
		await new Promise<void>((resolveExit, reject) => {
			child.once("close", () => resolveExit());
			child.once("error", reject);
		});
		await writeFile(
			join(handle.containerPath, "owner.json"),
			JSON.stringify({
				version: 1,
				token: handle.token,
				containerPath: handle.containerPath,
				originCwd: handle.originCwd,
				parentPid: pid,
				createdAt: Date.now(),
			}),
		);
		expect(await cleanupStaleDelegatedSandboxes()).toEqual([]);
		await expect(lstat(handle.containerPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("waits for disposed background batches to finish sandbox cleanup", async () => {
		let finish!: () => void;
		let aborted = false;
		const promise = new Promise<void>((resolveDone) => {
			finish = resolveDone;
		});
		const work = new SessionBackgroundWork({
			sessionManager: {} as never,
			isDisposed: () => true,
			emitProgress: () => {},
			onBatchSettled: () => {},
			deliverResult: async () => {},
		});
		work.trackExplore({
			batchId: "mirror",
			cwd: "fixture",
			tasks: [],
			settings: resolveSubAgentRuntimeSettings({ enabled: true }),
			abort: () => {
				aborted = true;
			},
			promise,
		});
		work.dispose();
		expect(aborted).toBe(true);
		let settled = false;
		const waiting = work.waitForExploreCleanup().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await waiting;
		expect(settled).toBe(true);
	});

	it("refuses live-worker cleanup and startup cleanup leaves live parents alone", async () => {
		const path = await origin();
		await writeFile(join(path, "ok"), "ok");
		const handle = await prepare(path);
		registerDelegatedSandboxWorker(handle, process.pid);
		expect((await finalizeDelegatedSandbox(handle)).removed).toBe(false);
		await cleanupStaleDelegatedSandboxes();
		expect((await lstat(handle.containerPath)).isDirectory()).toBe(true);
		await writeFile(
			join(handle.containerPath, "owner.json"),
			JSON.stringify({
				version: 1,
				token: handle.token,
				containerPath: handle.containerPath,
				originCwd: handle.originCwd,
				parentPid: process.pid,
				createdAt: Date.now(),
			}),
		);
	});
});
