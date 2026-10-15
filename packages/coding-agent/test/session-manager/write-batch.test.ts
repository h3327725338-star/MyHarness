import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearParseCache,
	dropPendingSessionWrites,
	flushSessionWrites,
	hasPendingSessionWrites,
	resetParseCacheOptions,
	resetSessionWriteBatchOptions,
	SessionManager,
	setSessionWriteBatchOptions,
} from "../../src/session/manager/index.ts";

type AppendInput = Parameters<SessionManager["appendMessage"]>[0];

const roots: string[] = [];

beforeEach(() => {
	// Use explicit defaults so individual threshold tests remain isolated.
	setSessionWriteBatchOptions({ enabled: true });
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	clearParseCache();
	resetParseCacheOptions();
	resetSessionWriteBatchOptions();
});

function assistantMessage(text: string, at: number): AppendInput {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: at,
	};
}

function toolResultMessage(toolCallId: string, at: number): AppendInput {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `result ${toolCallId}` }],
		isError: false,
		timestamp: at,
	};
}

/** A persisted session (first full write is always synchronous). */
function createFlushedSession(root: string, id: string): SessionManager {
	const session = SessionManager.create(root, root, { id });
	session.appendMessage({ role: "user", content: "hello", timestamp: 1000 });
	session.appendMessage(assistantMessage("hi", 1001));
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	expect(hasPendingSessionWrites(file)).toBe(false);
	return session;
}

describe("Session write batching", () => {
	it("supports explicit synchronous write-through", () => {
		setSessionWriteBatchOptions({ enabled: false });
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-off-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-off");
		const file = session.getSessionFile()!;

		const id = session.appendMessage({ role: "user", content: "direct", timestamp: 2000 });
		expect(hasPendingSessionWrites(file)).toBe(false);
		expect(readFileSync(file, "utf8")).toContain(id);
	});

	it("repairs a valid non-newline tail before appending", () => {
		const root = mkdtempSync(join(tmpdir(), "write-no-newline-"));
		roots.push(root);
		const original = createFlushedSession(root, "no-newline");
		const file = original.getSessionFile()!;
		original.releaseWriterLock();
		writeFileSync(file, readFileSync(file, "utf8").trimEnd());
		const reopened = SessionManager.open(file, root);
		const id = reopened.appendMessage({ role: "user", content: "after", timestamp: 3000 });
		reopened.flushPendingWrites();
		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.at(-1).id).toBe(id);
		expect(lines).toHaveLength(4);
		reopened.releaseWriterLock();
	});

	it("coalesces user/assistant appends and persists them on explicit flush, in order", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-order");
		const file = session.getSessionFile()!;

		const idA = session.appendMessage({ role: "user", content: "a", timestamp: 2000 });
		const idB = session.appendMessage(assistantMessage("b", 2001));
		expect(hasPendingSessionWrites(file)).toBe(true);
		// Not yet on disk.
		expect(readFileSync(file, "utf8")).not.toContain(idA);

		session.flushPendingWrites();
		expect(hasPendingSessionWrites(file)).toBe(false);

		const reopened = SessionManager.open(file, root);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(session.getEntries().map((entry) => entry.id));
		expect(reopened.getLeafId()).toBe(idB);
		void idA;
	});

	it("flushes pending lines before a checkpoint entry and writes it through", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-boundary-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-boundary");
		const file = session.getSessionFile()!;

		session.appendMessage({ role: "user", content: "before boundary", timestamp: 2000 });
		expect(hasPendingSessionWrites(file)).toBe(true);

		session.appendSessionInfo("boundary name");
		expect(hasPendingSessionWrites(file)).toBe(false);
		expect(readFileSync(file, "utf8")).toContain("boundary name");

		const reopened = SessionManager.open(file, root);
		expect(reopened.getSessionName()).toBe("boundary name");
		expect(reopened.getEntries()).toHaveLength(session.getEntries().length);
	});

	it("keeps tool results immediately durable for raw-JSONL sidecar readers", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-tool-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-tool");
		const file = session.getSessionFile()!;

		session.appendMessage({ role: "user", content: "run read", timestamp: 2000 });
		expect(hasPendingSessionWrites(file)).toBe(true);

		session.appendMessage(toolResultMessage("call-1", 2001));
		expect(hasPendingSessionWrites(file)).toBe(false);
		expect(readFileSync(file, "utf8")).toContain("call-1");
	});

	it("flushes coalesced lines on lock release, the normal-close path", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-close-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-close");
		const file = session.getSessionFile()!;

		session.acquireWriterLock();
		try {
			session.appendMessage({ role: "user", content: "before close", timestamp: 2000 });
			session.appendMessage(assistantMessage("closing", 2001));
			expect(hasPendingSessionWrites(file)).toBe(true);
			session.releaseWriterLock();
		} finally {
			session.releaseWriterLock();
		}
		expect(hasPendingSessionWrites(file)).toBe(false);

		const reopened = SessionManager.open(file, root);
		expect(reopened.getEntries()).toHaveLength(4);
	});

	it("flushes coalesced lines on reads, keeping same-process read-your-writes", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-read-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-read");
		const file = session.getSessionFile()!;

		session.appendMessage({ role: "user", content: "fresh question", timestamp: 2000 });
		session.appendMessage(assistantMessage("fresh answer", 2001));
		expect(hasPendingSessionWrites(file)).toBe(true);

		const listed = await SessionManager.list(root, root);
		const info = listed.find((entry) => entry.path === file);
		expect(info?.messageCount).toBe(4);
		expect(hasPendingSessionWrites(file)).toBe(false);
	});

	it("flushes automatically after the batch window", async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-timer-"));
		roots.push(root);
		setSessionWriteBatchOptions({ flushIntervalMs: 10 });
		const session = createFlushedSession(root, "batch-timer");
		const file = session.getSessionFile()!;

		const id = session.appendMessage({ role: "user", content: "timer flush", timestamp: 2000 });
		const deadline = Date.now() + 5000;
		while (hasPendingSessionWrites(file) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(hasPendingSessionWrites(file)).toBe(false);
		expect(readFileSync(file, "utf8")).toContain(id);
	});

	it("flushes immediately once the byte threshold is reached", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-bytes-"));
		roots.push(root);
		setSessionWriteBatchOptions({ maxBatchBytes: 64 });
		const session = createFlushedSession(root, "batch-bytes");
		const file = session.getSessionFile()!;

		const id = session.appendMessage({ role: "user", content: "x".repeat(200), timestamp: 2000 });
		expect(hasPendingSessionWrites(file)).toBe(false);
		expect(readFileSync(file, "utf8")).toContain(id);
	});

	it("loses only the unflushed window on a simulated crash, never tearing the file", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-crash-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-crash");
		const file = session.getSessionFile()!;

		session.appendMessage({ role: "user", content: "lost window", timestamp: 2000 });
		session.appendMessage(assistantMessage("lost reply", 2001));
		expect(hasPendingSessionWrites(file)).toBe(true);

		// Simulate a kill -9: pending lines vanish, the file keeps complete lines.
		dropPendingSessionWrites(file);
		const reopened = SessionManager.open(file, root);
		expect(reopened.getEntries()).toHaveLength(2);
		expect(reopened.getLoadDiagnostics()).toBeUndefined();
		// The crashed manager still holds its in-memory truth.
		expect(session.getEntries()).toHaveLength(4);

		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("leaves in-memory sessions untouched and flush helpers safe to call", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "ephemeral", timestamp: 1000 });
		expect(() => session.flushPendingWrites()).not.toThrow();
		expect(() => session.releaseWriterLock()).not.toThrow();
		expect(() => flushSessionWrites("nonexistent-file.jsonl")).not.toThrow();
	});

	it("flushes pending lines from ensureSaved before the saved-state check", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-write-batch-saved-"));
		roots.push(root);
		const session = createFlushedSession(root, "batch-saved");
		const file = session.getSessionFile()!;

		const id = session.appendMessage({ role: "user", content: "save me", timestamp: 2000 });
		expect(hasPendingSessionWrites(file)).toBe(true);
		session.ensureSaved();
		expect(hasPendingSessionWrites(file)).toBe(false);
		expect(readFileSync(file, "utf8")).toContain(id);
	});
});
