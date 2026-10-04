import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/platform/process/exec.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { cleanupOrphanedToolResults, persistToolText } from "../src/tools/tool-result-persistence.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const sessionManagerSource = pathToFileURL(
	resolve(repoRoot, "packages/coding-agent/src/session/manager/index.ts"),
).href;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function terminateTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			// The process may have completed between the liveness check and taskkill.
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The process may have completed between the liveness check and kill.
	}
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await delay(20);
	}
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolveClose, reject) => {
		child.once("close", () => resolveClose());
		child.once("error", reject);
	});
}

function assertJsonlIsFullyValid(filePath: string): void {
	for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
		if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
	}
}

function createWorkerDriver(root: string): string {
	const driver = join(root, "session-pressure-worker.mjs");
	writeFileSync(
		driver,
		`import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from ${JSON.stringify(sessionManagerSource)};

const [root, id, countText, delayText, mode] = process.argv.slice(2);
const sessionDir = join(root, "sessions", id);
const manager = SessionManager.create(root, sessionDir, { id });
manager.acquireWriterLock();
const file = manager.getSessionFile();
if (!file) throw new Error("Session file was not created");
writeFileSync(join(root, id + ".ready.json"), JSON.stringify({ file, sessionDir }));

if (mode === "hold") {
	setInterval(() => {}, 1000);
} else {
	const count = Number(countText);
	const pause = Number(delayText);
	for (let i = 0; i < count; i++) {
		const timestamp = Date.now();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: id + " user " + i }], timestamp });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: id + " assistant " + i }],
			api: "openai-responses",
			provider: "sudocode",
			model: "gpt-5.6-luna",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp,
		});
		if (pause > 0 && i % 2 === 0) await new Promise((resolve) => setTimeout(resolve, pause));
	}
	manager.releaseWriterLock();
}
`,
		"utf8",
	);
	return driver;
}

async function spawnWorker(
	driver: string,
	root: string,
	id: string,
	count: number,
	pause: number,
	mode = "append",
): Promise<{ child: ReturnType<typeof spawn>; file: string; sessionDir: string }> {
	const child = spawn(process.execPath, ["--import", "tsx", driver, root, id, String(count), String(pause), mode], {
		cwd: repoRoot,
		stdio: "ignore",
		windowsHide: true,
	});
	const readyPath = join(root, `${id}.ready.json`);
	await waitForFile(readyPath);
	// The file appears before its content is fully written, so wait until it parses.
	let ready: { file: string; sessionDir: string } | undefined;
	for (const deadline = Date.now() + 10_000; !ready; await delay(20)) {
		try {
			ready = JSON.parse(readFileSync(readyPath, "utf8")) as { file: string; sessionDir: string };
		} catch (error) {
			if (Date.now() >= deadline) throw error;
		}
	}
	return { child, file: ready.file, sessionDir: ready.sessionDir };
}

describe("Session persistence and process recovery pressure", () => {
	it("recovers interrupted writers, context state, tool sidecars, and process trees", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-session-pressure-"));
		roots.push(root);
		const driver = createWorkerDriver(root);

		const workerPromises = ["worker-a", "worker-b", "worker-c", "worker-d", "worker-e", "worker-f"].map((id) =>
			spawnWorker(driver, root, id, 140, 3),
		);
		const workers = await Promise.all(workerPromises);

		await delay(100);
		terminateTree(workers[1]!.child.pid);
		await delay(120);
		terminateTree(workers[4]!.child.pid);
		await Promise.all(workers.map(({ child }) => waitForClose(child)));

		for (const { file, sessionDir } of workers) {
			const reopened = SessionManager.open(file, sessionDir);
			const diagnostics = reopened.getLoadDiagnostics();
			if (diagnostics) expect(diagnostics.recovered).toBe(true);
			if (diagnostics?.issues.some((issue) => issue.kind === "truncated_tail")) {
				reopened.appendMessage({ role: "user", content: "recovery user", timestamp: Date.now() });
				reopened.appendMessage({ role: "assistant", content: "recovery assistant", timestamp: Date.now() } as any);
			}
			assertJsonlIsFullyValid(file);
			expect(reopened.getEntries().length).toBeGreaterThan(1);
		}

		for (let round = 0; round < 4; round++) {
			const held = await spawnWorker(driver, root, `lock-${round}`, 0, 0, "hold");
			terminateTree(held.child.pid);
			await waitForClose(held.child);
			expect(existsSync(`${held.file}.lock`)).toBe(true);
			expect(existsSync(`${held.file}.lock.owner`)).toBe(true);
			const reopened = SessionManager.open(held.file, held.sessionDir);
			expect(() => reopened.acquireWriterLock()).not.toThrow();
			reopened.releaseWriterLock();
		}

		const truncated = workers[0]!;
		appendFileSync(truncated.file, '{"type":"message"', "utf8");
		const recovered = SessionManager.open(truncated.file, truncated.sessionDir);
		expect(recovered.getLoadDiagnostics()?.issues.some((issue) => issue.kind === "truncated_tail")).toBe(true);
		recovered.appendMessage({ role: "user", content: "repair tail", timestamp: Date.now() });
		recovered.appendMessage({ role: "assistant", content: "repair complete", timestamp: Date.now() } as any);
		assertJsonlIsFullyValid(truncated.file);

		const contextDir = join(root, "context-session");
		const contextSession = SessionManager.create(root, contextDir, { id: "context-pressure" });
		for (let i = 0; i < 45; i++) {
			contextSession.appendMessage({ role: "user", content: `context user ${i}`, timestamp: Date.now() });
			contextSession.appendMessage({
				role: "assistant",
				content: `context assistant ${i}`,
				timestamp: Date.now(),
			} as any);
		}
		const entriesBeforeCompaction = contextSession.getEntries();
		const keptId = entriesBeforeCompaction[25]!.id;
		contextSession.appendCompaction("pressure compaction summary", keptId, 90_000);
		const context = contextSession.buildSessionContext();
		expect(context.messages.some((message) => JSON.stringify(message).includes("pressure compaction summary"))).toBe(
			true,
		);
		expect(context.messages.length).toBeLessThan(entriesBeforeCompaction.length);

		const toolDir = join(root, "tool-session");
		const toolSession = SessionManager.create(root, toolDir, { id: "tool-pressure" });
		toolSession.appendMessage({ role: "user", content: "tool persistence", timestamp: Date.now() });
		toolSession.appendMessage({ role: "assistant", content: "ready", timestamp: Date.now() } as any);
		for (let i = 0; i < 18; i++) {
			const fullPath = await persistToolText(
				toolSession,
				"read",
				`pressure-${i}`,
				`tool output ${i}\n`.repeat(5000),
			);
			toolSession.appendMessage({
				role: "toolResult",
				toolCallId: `pressure-${i}`,
				toolName: "read",
				content: [{ type: "text", text: `fullOutputPath=${fullPath}` }],
				isError: false,
				timestamp: Date.now(),
			} as any);
		}
		const referenced = await cleanupOrphanedToolResults(toolDir, { graceMs: 1_000 });
		expect(referenced.errors).toHaveLength(0);
		expect(referenced.referenced).toHaveLength(18);
		const orphanPath = await persistToolText(toolSession, "read", "unreferenced", "orphan output");
		const orphanSeenAt = Date.now();
		const pending = await cleanupOrphanedToolResults(toolDir, { graceMs: 1_000, nowMs: orphanSeenAt });
		expect(pending.pending).toContain(orphanPath);
		const quarantined = await cleanupOrphanedToolResults(toolDir, { graceMs: 1_000, nowMs: orphanSeenAt + 2_000 });
		expect(quarantined.quarantined).toHaveLength(1);
		const idempotent = await cleanupOrphanedToolResults(toolDir, { graceMs: 1_000, nowMs: orphanSeenAt + 3_000 });
		expect(idempotent.quarantined).toHaveLength(0);

		const cancellationProbes = await Promise.all(
			Array.from({ length: 5 }, async (_, index) => {
				const marker = join(root, `cancel-${index}.marker`);
				const started = join(root, `cancel-${index}.started`);
				const ready = join(root, `cancel-${index}.ready`);
				const descendant = `require("node:fs").writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, startedAt: Date.now() })); setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"); process.exit(0); }, 700); setInterval(() => {}, 1000);`;
				const parent = `const fs = require("node:fs"); const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); const announceReady = () => { if (fs.existsSync(${JSON.stringify(started)})) fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, child: child.pid })); else setTimeout(announceReady, 5); }; announceReady(); setInterval(() => {}, 1000);`;
				const controller = new AbortController();
				const resultPromise = execCommand(process.execPath, ["-e", parent], repoRoot, {
					signal: controller.signal,
					killGraceMs: 150,
				});
				await waitForFile(ready);
				controller.abort();
				const result = await resultPromise;
				await delay(850);
				return { result, marker };
			}),
		);
		for (const { result, marker } of cancellationProbes) {
			expect(result.killed).toBe(true);
			expect([124, 130]).toContain(result.code);
			expect(existsSync(marker), `descendant marker survived cancellation: ${marker}`).toBe(false);
		}
	}, 120_000);
});
