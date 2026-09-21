import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnProcessMock, spawnProcessSyncMock } = vi.hoisted(() => ({
	spawnProcessMock: vi.fn(),
	spawnProcessSyncMock: vi.fn(),
}));

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: spawnProcessMock,
	spawnProcessSync: spawnProcessSyncMock,
}));

import { runGit, runGitSync, runGitToFile } from "../src/utils/git-command.ts";

class MockGitProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;

	kill(): boolean {
		this.killed = true;
		this.emit("close", null, "SIGTERM");
		return true;
	}
}

describe("git command runner", () => {
	beforeEach(() => {
		spawnProcessMock.mockReset();
		spawnProcessSyncMock.mockReset();
	});

	it("uses non-interactive child environment and captures output", async () => {
		const child = new MockGitProcess();
		spawnProcessMock.mockReturnValueOnce(child);

		const resultPromise = runGit(["status", "--short"], { cwd: "C:\\repo" });
		const [, args, options] = spawnProcessMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];

		expect(args).toEqual(["status", "--short"]);
		expect(options.env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			GIT_PAGER: "cat",
		});

		child.stdout.write(" M file.ts\n");
		child.stderr.end();
		child.stdout.end();
		child.emit("close", 0, null);

		await expect(resultPromise).resolves.toMatchObject({
			ok: true,
			stdout: " M file.ts\n",
			exitCode: 0,
		});
	});

	it("classifies a non-zero Git exit separately from a spawn failure", async () => {
		const child = new MockGitProcess();
		spawnProcessMock.mockReturnValueOnce(child);

		const resultPromise = runGit(["rev-parse", "HEAD"]);
		child.stderr.write("not a repository\n");
		child.stderr.end();
		child.stdout.end();
		child.emit("close", 128, null);

		await expect(resultPromise).resolves.toMatchObject({
			ok: false,
			failureKind: "exit",
			exitCode: 128,
			error: expect.stringContaining("not a repository"),
		});
	});

	it("kills and classifies a Git process that exceeds its timeout", async () => {
		const child = new MockGitProcess();
		spawnProcessMock.mockReturnValueOnce(child);

		await expect(runGit(["fetch"], { timeoutMs: 10 })).resolves.toMatchObject({
			ok: false,
			failureKind: "timeout",
		});
		expect(child.killed).toBe(true);
	});

	it("kills and classifies a Git process cancelled by its signal", async () => {
		const child = new MockGitProcess();
		spawnProcessMock.mockReturnValueOnce(child);
		const controller = new AbortController();

		const resultPromise = runGit(["fetch"], { signal: controller.signal });
		controller.abort();

		await expect(resultPromise).resolves.toMatchObject({
			ok: false,
			failureKind: "cancelled",
		});
		expect(child.killed).toBe(true);
	});

	it("uses the same environment and timeout policy for synchronous Git calls", () => {
		spawnProcessSyncMock.mockReturnValueOnce({
			status: 0,
			signal: null,
			stdout: "main\n",
			stderr: "",
			error: undefined,
		});

		const result = runGitSync(["branch", "--show-current"], { cwd: "C:\\repo", timeoutMs: 5000 });
		const [, args, options] = spawnProcessSyncMock.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
		];

		expect(args).toEqual(["branch", "--show-current"]);
		expect(options.timeout).toBe(5000);
		expect(options.maxBuffer).toBeGreaterThan(0);
		expect(Number.isFinite(options.maxBuffer)).toBe(true);
		expect(options.env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			GIT_PAGER: "cat",
		});
		expect(result).toMatchObject({ ok: true, stdout: "main", exitCode: 0 });
	});

	it("streams large stdout directly to a file without buffering the complete patch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-git-command-test-"));
		const outputPath = join(directory, "output.patch");
		try {
			const child = new MockGitProcess();
			spawnProcessMock.mockReturnValueOnce(child);
			const payload = Buffer.alloc(2 * 1024 * 1024, 0x78);

			const resultPromise = runGitToFile(["diff", "--cached", "--binary"], outputPath, { cwd: "C:\\repo" });
			child.stdout.write(payload);
			child.stderr.end();
			child.stdout.end();
			child.emit("close", 0, null);

			const result = await resultPromise;
			expect(result).toMatchObject({
				ok: true,
				stdout: "",
				stdoutPath: outputPath,
				stdoutBytes: payload.length,
				stdoutSha256: createHash("sha256").update(payload).digest("hex"),
			});
			expect(readFileSync(outputPath)).toEqual(payload);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("preserves an existing output file when cancelled before starting", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-git-command-test-"));
		const outputPath = join(directory, "existing.patch");
		writeFileSync(outputPath, "KEEP", "utf8");
		try {
			const controller = new AbortController();
			controller.abort();

			const result = await runGitToFile(["diff", "--cached", "--binary"], outputPath, {
				signal: controller.signal,
			});

			expect(result).toMatchObject({ ok: false, failureKind: "cancelled" });
			expect(existsSync(outputPath)).toBe(true);
			expect(readFileSync(outputPath, "utf8")).toBe("KEEP");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves an existing output file when exclusive creation fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "myharness-git-command-test-"));
		const outputPath = join(directory, "existing.patch");
		writeFileSync(outputPath, "KEEP", "utf8");
		try {
			const result = await runGitToFile(["--version"], outputPath, { timeoutMs: 5_000 });

			expect(result).toMatchObject({ ok: false, failureKind: "spawn" });
			expect(result.error).toContain("EEXIST");
			expect(existsSync(outputPath)).toBe(true);
			expect(readFileSync(outputPath, "utf8")).toBe("KEEP");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
