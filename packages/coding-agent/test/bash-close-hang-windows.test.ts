import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, createLocalBashOperations } from "../src/tools/shell/bash.ts";
import { executeBashWithOperations } from "../src/tools/shell/executor.ts";
import { killProcessTreeAndWait } from "../src/utils/shell.ts";

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function createInheritedStdioCommand(pidFile: string): string {
	const pidFileArg = toBashSingleQuotedArg(pidFile);
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		pidFileArg
	);
}

function createStreamingInheritedStdioCommand(pidFile: string): string {
	const pidFileArg = toBashSingleQuotedArg(pidFile);
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn(process.execPath,['-e','setInterval(()=>process.stdout.write(String.fromCharCode(116,105,99,107,10)),50)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		pidFileArg
	);
}

async function cleanupDetachedChild(pidFile: string): Promise<void> {
	if (!existsSync(pidFile)) {
		return;
	}

	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (Number.isFinite(pid) && pid > 0) {
		const exited = await killProcessTreeAndWait(pid);
		if (!exited) throw new Error(`Detached child process ${pid} did not exit during test cleanup.`);
	}
}

function isProcessAlive(pid: number): boolean {
	const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
		encoding: "utf8",
		windowsHide: true,
	});
	return result.status === 0 && new RegExp(`\\b${pid}\\b`).test(result.stdout ?? "");
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);

		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

describe.skipIf(process.platform !== "win32")("Windows child-process close handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-bash-close-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("executeBash resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "executor-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();

		try {
			const result = await withTimeout(
				executeBashWithOperations(command, process.cwd(), createLocalBashOperations(), {
					signal: controller.signal,
				}),
				3000,
				() => {
					controller.abort();
				},
			);

			expect(result.output).toContain("child-exiting");
			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
		} finally {
			controller.abort();
			await cleanupDetachedChild(pidFile);
		}
	});

	it("bash tool resolves after the shell exits even if inherited stdio handles stay open", async () => {
		const pidFile = join(testDir, "tool-grandchild.pid");
		const command = createInheritedStdioCommand(pidFile);
		const controller = new AbortController();
		const bashTool = createBashTool(testDir);

		try {
			const result = await withTimeout(bashTool.execute("test-call", { command }, controller.signal), 3000, () => {
				controller.abort();
			});

			expect(getTextOutput(result)).toContain("child-exiting");
		} finally {
			controller.abort();
			await cleanupDetachedChild(pidFile);
		}
	});

	it("does not wait for a continuously writing inherited background process", async () => {
		const pidFile = join(testDir, "streaming-grandchild.pid");
		const command = createStreamingInheritedStdioCommand(pidFile);
		const controller = new AbortController();
		const bashTool = createBashTool(testDir);
		const startedAt = Date.now();

		try {
			const result = await withTimeout(
				bashTool.execute("test-call-streaming-background", { command, timeout: 5 }, controller.signal),
				2500,
				() => controller.abort(),
			);
			const elapsed = Date.now() - startedAt;

			expect(elapsed).toBeLessThan(2000);
			expect(getTextOutput(result)).toContain("child-exiting");
			expect(getTextOutput(result)).toContain("tick");
		} finally {
			controller.abort();
			await cleanupDetachedChild(pidFile);
		}
	});

	it("terminates an inherited background process when the Bash timeout wins", async () => {
		const pidFile = join(testDir, "streaming-timeout-grandchild.pid");
		const command = createStreamingInheritedStdioCommand(pidFile);
		const controller = new AbortController();
		const bashTool = createBashTool(testDir);

		try {
			await expect(
				bashTool.execute("test-call-streaming-timeout", { command, timeout: 0.3 }, controller.signal),
			).rejects.toMatchObject({ code: "BASH_TIMEOUT" });

			expect(existsSync(pidFile)).toBe(true);
			const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
			expect(Number.isFinite(pid)).toBe(true);
			if (Number.isFinite(pid)) {
				expect(await waitForProcessExit(pid)).toBe(true);
			}
		} finally {
			controller.abort();
			await cleanupDetachedChild(pidFile);
		}
	});
});
