import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/agent/runtime/agent-session.ts";
import {
	buildHandoffTask,
	handoffWork,
	resolveHandoffModel,
	SessionHandoff,
} from "../src/agent/runtime/session-handoff.ts";
import { getSessionConversationPath } from "../src/config/paths/index.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { readHandoff, writeHandoff } from "../src/session/history/handoff-store.ts";
import { resetHistoryIndexForTests } from "../src/session/history/index-store.ts";
import { clearParseCache } from "../src/session/storage/jsonl/parse-cache.ts";

const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "session-handoff-"));
let dataRoot = "";
let counter = 0;
let clock = Date.parse("2026-10-02T08:00:00Z");

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	dataRoot = join(root, `data-${++counter}`);
	resetHistoryIndexForTests();
	clearParseCache();
});

function line(role: "user" | "assistant", text: string, id: string, parentId: string | null, stop = "stop"): string {
	clock += 60_000;
	const message =
		role === "user"
			? { role, content: [{ type: "text", text }], timestamp: clock }
			: {
					role,
					content: [{ type: "text", text }],
					api: "openai-responses",
					provider: "test",
					model: "m",
					stopReason: stop,
					timestamp: clock,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
	return `${JSON.stringify({ type: "message", id, parentId, timestamp: new Date(clock).toISOString(), message })}\n`;
}

function chat(): string {
	const file = getSessionConversationPath(dataRoot, "ws", "s1", "chat.jsonl");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date(clock).toISOString(), cwd: root, mode: "general" })}\n${line("user", "我每天喝 3 升水", "u1", null)}${line("assistant", "偏多", "a1", "u1")}`,
	);
	return file;
}

function reply(text: string, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: {} };
}

function fakeSession(file: string, settings: SettingsManager, completeSimple: ReturnType<typeof vi.fn>) {
	return {
		sessionFile: file,
		settingsManager: settings,
		isMirror: false,
		sessionManager: { isPersisted: () => true },
		model: { provider: "test", id: "main" },
		thinkingLevel: "off",
		sessionName: "饮水",
		modelRuntime: { getModel: (provider: string, id: string) => ({ provider, id }), completeSimple },
	} as unknown as AgentSession;
}

describe("SessionHandoff", () => {
	it("writes a note, then updates it from the existing note plus the new messages only", async () => {
		const file = chat();
		const settings = SettingsManager.inMemory();
		const completeSimple = vi.fn().mockResolvedValue(reply("NOTE-1"));
		const handoff = new SessionHandoff(fakeSession(file, settings, completeSimple), () => true);
		expect(await handoff.runNow()).toBe(true);
		expect(readHandoff(file)).toMatchObject({
			summary: "NOTE-1",
			coveredEntryId: "a1",
			provider: "test",
			model: "main",
		});
		expect(handoffWork(file)).toBeUndefined();

		appendFileSync(file, line("user", "说错了，是 2 升", "u2", "a1") + line("assistant", "那正常", "a2", "u2"));
		completeSimple.mockResolvedValue(reply("NOTE-2"));
		expect(await handoff.runNow()).toBe(true);
		const task = completeSimple.mock.calls[1]![1].messages[0].content[0].text as string;
		expect(task).toContain("NOTE-1");
		expect(task).toContain("说错了，是 2 升");
		expect(task).not.toContain("我每天喝 3 升水");
		expect(readHandoff(file)).toMatchObject({ summary: "NOTE-2", coveredEntryId: "a2" });
		handoff.dispose();
	});

	it("never lets an older run overwrite a note written meanwhile", async () => {
		const file = chat();
		const settings = SettingsManager.inMemory();
		const completeSimple = vi.fn().mockImplementation(async () => {
			writeHandoff(file, {
				version: 1,
				sessionId: "s1",
				summary: "NEWER",
				coveredEntryId: "a1",
				coveredCount: 2,
				updatedAt: new Date().toISOString(),
			});
			return reply("OLDER");
		});
		const handoff = new SessionHandoff(fakeSession(file, settings, completeSimple), () => true);
		expect(await handoff.runNow()).toBe(false);
		expect(readHandoff(file)?.summary).toBe("NEWER");
		handoff.dispose();
	});

	it("reports failures, keeps the work, and does nothing when switched off", async () => {
		const file = chat();
		const settings = SettingsManager.inMemory();
		const completeSimple = vi.fn().mockResolvedValue(reply("", "error"));
		const statuses: unknown[] = [];
		const handoff = new SessionHandoff(
			fakeSession(file, settings, completeSimple),
			() => true,
			(status) => statuses.push(status),
		);
		expect(await handoff.runNow()).toBe(false);
		expect(handoff.status).toMatchObject({ phase: "retrying", retries: 1 });
		expect(readHandoff(file)).toBeUndefined();
		expect(handoffWork(file)).toBeDefined();
		handoff.dispose();

		settings.setSessionContinuitySettings({ autoHandoff: false });
		const off = new SessionHandoff(fakeSession(file, settings, completeSimple), () => true);
		expect(await off.runNow()).toBe(false);
		expect(completeSimple).toHaveBeenCalledTimes(1);
		off.dispose();
	});

	it("hands work still due to the host's next instance when the chat is switched away", async () => {
		const file = chat();
		const completeSimple = vi.fn().mockResolvedValue(reply("NOTE"));
		const left = new SessionHandoff(fakeSession(file, SettingsManager.inMemory(), completeSimple), () => true);
		left.refresh();
		const owed = left.dispose();
		expect(owed).toEqual([file]);
		expect(completeSimple).not.toHaveBeenCalled();

		const next = new SessionHandoff(
			fakeSession(undefined as unknown as string, SettingsManager.inMemory(), completeSimple),
			() => true,
		);
		next.adopt(owed);
		expect(await next.runNow()).toBe(true);
		expect(readHandoff(file)).toMatchObject({ summary: "NOTE", coveredEntryId: "a1" });
		expect(completeSimple.mock.calls[0]![1].messages[0].content[0].text).toContain("我每天喝 3 升水");
		expect(next.dispose()).toEqual([]);
	});

	it("waits while the chat is busy", async () => {
		const file = chat();
		const completeSimple = vi.fn().mockResolvedValue(reply("NOTE"));
		const handoff = new SessionHandoff(fakeSession(file, SettingsManager.inMemory(), completeSimple), () => false);
		expect(await handoff.runNow()).toBe(false);
		expect(completeSimple).not.toHaveBeenCalled();
		handoff.dispose();
	});

	it("marks interrupted replies in the task and rebuilds when the note left the branch", () => {
		const file = chat();
		appendFileSync(file, line("user", "再问一个", "u2", "a1") + line("assistant", "写到一半", "a2", "u2", "aborted"));
		writeHandoff(file, {
			version: 1,
			sessionId: "s1",
			summary: "OLD",
			coveredEntryId: "gone",
			coveredCount: 2,
			updatedAt: new Date().toISOString(),
		});
		const work = handoffWork(file)!;
		expect(work.incremental).toBe(false);
		const task = buildHandoffTask(work, "饮水");
		expect(task).toContain("not usable");
		expect(task).toContain("Assistant (interrupted)");
		expect(task).not.toContain("<existing-note>");
	});
});

describe("resolveHandoffModel", () => {
	const main = { provider: "p", id: "main", thinkingLevel: "high" as const };
	it("uses its own model, then the compaction model, then the main model", () => {
		const settings = SettingsManager.inMemory();
		expect(resolveHandoffModel(settings, main)).toEqual({ provider: "p", model: "main", thinkingLevel: "high" });
		settings.setCompactionModelSettings({ provider: "c", model: "compact" });
		expect(resolveHandoffModel(settings, main)).toMatchObject({ provider: "c", model: "compact" });
		settings.setSessionContinuitySettings({ provider: "h", model: "handoff", thinkingLevel: "low" });
		expect(resolveHandoffModel(settings, main)).toEqual({ provider: "h", model: "handoff", thinkingLevel: "low" });
	});
});
