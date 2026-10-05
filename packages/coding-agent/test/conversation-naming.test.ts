import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@myharness/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/agent/runtime/agent-session.ts";
import {
	CONVERSATION_NAMING_INTERVAL_MS,
	CONVERSATION_NAMING_STATE,
	ConversationNaming,
	conversationNamingWork,
} from "../src/agent/runtime/conversation-naming.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";

function reply(text = "answer", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "main",
		stopReason,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function fixture() {
	const manager = SessionManager.inMemory();
	const settings = SettingsManager.inMemory();
	settings.setConversationNamingSettings({ enabled: true, provider: "test", model: "namer", thinkingLevel: "low" });
	const model = { provider: "test", id: "namer" };
	const completeSimple = vi.fn().mockResolvedValue(reply("对话自动命名"));
	const session = {
		sessionManager: manager,
		sessionFile: "test.jsonl",
		settingsManager: settings,
		isMirror: false,
		model: { provider: "test", id: "main" },
		thinkingLevel: "high",
		sessionName: undefined as string | undefined,
		modelRuntime: { getModel: vi.fn(() => model), completeSimple },
		setSessionName: (name: string) => {
			session.sessionName = name;
			manager.appendSessionInfo(name);
		},
	};
	manager.appendMessage({ role: "user", content: "Implement automatic naming", timestamp: Date.now() });
	manager.appendMessage(reply());
	const worker = new ConversationNaming(session as unknown as AgentSession, () => true);
	return { manager, settings, session, worker, completeSimple, model };
}
afterEach(() => vi.useRealTimers());

describe("background conversation naming", () => {
	it("uses the configured helper and effort, names once, and checks only new replies after ten minutes", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.worker.refresh();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.session.sessionName).toBe("对话自动命名");
		expect(f.completeSimple).toHaveBeenCalledWith(
			f.model,
			expect.anything(),
			expect.objectContaining({ reasoning: "low" }),
		);
		expect(conversationNamingWork(f.manager)).toBeUndefined();
		f.manager.appendMessage(reply("new reply"));
		f.worker.refresh();
		await vi.advanceTimersByTimeAsync(CONVERSATION_NAMING_INTERVAL_MS - 1);
		expect(f.completeSimple).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.completeSimple).toHaveBeenCalledTimes(2);
		expect(f.completeSimple.mock.calls[1][1].messages[0].content).toContain("main topic has materially changed");
		expect(conversationNamingWork(f.manager)).toBeUndefined();
		f.worker.dispose();
	});

	it("retains pending work across worker disposal and catches up when reopened", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.worker.refresh();
		await vi.advanceTimersByTimeAsync(1);
		f.manager.appendMessage(reply("pending"));
		f.worker.refresh();
		f.worker.dispose();
		await vi.advanceTimersByTimeAsync(CONVERSATION_NAMING_INTERVAL_MS);
		expect(f.completeSimple).toHaveBeenCalledTimes(1);
		const reopened = new ConversationNaming(f.session as unknown as AgentSession, () => true);
		reopened.refresh();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.completeSimple).toHaveBeenCalledTimes(2);
		reopened.dispose();
	});

	it("protects pre-existing and subsequently manual titles, and ignores aborted/tool replies", () => {
		const f = fixture();
		const work = conversationNamingWork(f.manager)!;
		const titleEntryId = f.manager.appendSessionInfo("automatic");
		f.manager.appendCustomEntry(CONVERSATION_NAMING_STATE, {
			checkedReplyId: work.replyId,
			checkedAt: 0,
			titleEntryId,
		});
		f.manager.appendMessage(reply("cancelled", "aborted"));
		f.manager.appendMessage(reply("tool", "toolUse"));
		expect(conversationNamingWork(f.manager)).toBeUndefined();
		f.manager.appendMessage(reply("next"));
		expect(conversationNamingWork(f.manager)).toBeDefined();
		f.manager.appendSessionInfo("My chosen title");
		expect(conversationNamingWork(f.manager)).toBeUndefined();
		f.worker.dispose();
	});

	it("does not overwrite a manual rename made during the model request", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let finish!: (value: AssistantMessage) => void;
		f.completeSimple.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		f.worker.refresh();
		await vi.advanceTimersByTimeAsync(1);
		f.session.setSessionName("Manual");
		finish(reply("AI"));
		await vi.advanceTimersByTimeAsync(1);
		expect(f.session.sessionName).toBe("Manual");
		f.worker.dispose();
	});

	it("leaves failed requests pending and cancels without waiting on disposal", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.completeSimple.mockRejectedValue(new Error("offline"));
		f.worker.refresh();
		await vi.advanceTimersByTimeAsync(1);
		expect(conversationNamingWork(f.manager)).toBeDefined();
		expect(f.session.sessionName).toBeUndefined();
		f.worker.dispose();
		await vi.advanceTimersByTimeAsync(CONVERSATION_NAMING_INTERVAL_MS);
		expect(f.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("restores pending progress from the saved JSONL after reload", () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR!, "naming-recovery-"));
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "Name this conversation", timestamp: Date.now() });
		manager.appendMessage(reply());
		const checked = conversationNamingWork(manager)!;
		const titleEntryId = manager.appendSessionInfo("Automatic title");
		manager.appendCustomEntry(CONVERSATION_NAMING_STATE, {
			checkedReplyId: checked.replyId,
			checkedAt: 1000,
			titleEntryId,
		});
		manager.appendMessage(reply("pending reply"));
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(conversationNamingWork(reopened, 1001)?.delay).toBe(CONVERSATION_NAMING_INTERVAL_MS - 1);
		expect(conversationNamingWork(reopened, 1000 + CONVERSATION_NAMING_INTERVAL_MS)?.delay).toBe(0);
	});

	it("preserves explicit settings and defaults to disabled", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getConversationNamingSettings().enabled).toBe(false);
		settings.setConversationNamingSettings({ enabled: true });
		expect(settings.getConversationNamingSettings().enabled).toBe(true);
		settings.setConversationNamingSettings({
			enabled: false,
			provider: "test",
			model: "namer",
			thinkingLevel: "low",
		});
		expect(settings.getConversationNamingSettings()).toEqual({
			enabled: false,
			provider: "test",
			model: "namer",
			thinkingLevel: "low",
		});
	});
});
