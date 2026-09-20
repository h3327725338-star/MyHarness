import type { AgentTool } from "@myharness/agent-core";
import { describe, expect, it } from "vitest";
import { createHarness, fauxModel } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Codex context window integration", () => {
	it("compacts with the previous model before switching to a smaller window", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 128000 },
			responses: ["checkpoint"],
			tools: [],
		});
		try {
			const message = { role: "user" as const, content: "x".repeat(240000), timestamp: Date.now() };
			h.sessionManager.appendMessage(message);
			h.agent.state.messages = [message];
			await h.session.setModel({ ...fauxModel, contextWindow: 64000 });
			expect(h.faux.callCount).toBe(1);
			expect(h.session.effectiveContextWindow).toBe(64000);
			expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		} finally {
			h.cleanup();
		}
	});
	it("continues a real tool batch after one compaction with summary last", async () => {
		const tool: AgentTool = {
			name: "large",
			label: "Large",
			description: "large output",
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(50 * 1024) }], details: {} }),
		};
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 64000 },
			tools: [tool],
			responses: [
				{ toolCalls: Array.from({ length: 6 }, () => ({ name: "large", args: {} })) },
				"checkpoint",
				"done",
			],
		});
		try {
			await h.session.prompt("run tool");
			expect(h.faux.callCount).toBe(3);
			expect(h.eventsOfType("compaction_end")).toHaveLength(1);
			expect(JSON.stringify(h.faux.contexts[1])).toContain("x".repeat(10000));
			expect(h.faux.contexts[2]?.messages.at(-1)?.role).toBe("user");
			expect(JSON.stringify(h.faux.contexts[2]?.messages.at(-1))).toContain("checkpoint");
			expect(h.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			});
		} finally {
			h.cleanup();
		}
	});
	it("compacts a tool continuation based on provider usage even if local history is small", async () => {
		const tool: AgentTool = {
			name: "small",
			label: "Small",
			description: "small output",
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text", text: "result" }], details: {} }),
		};
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			tools: [tool],
			responses: [
				{ toolCalls: [{ name: "small", args: {} }], usage: { input: 91000, totalTokens: 91000 } },
				"checkpoint",
				"done",
			],
		});
		try {
			await h.session.prompt("run tool");
			expect(h.faux.callCount).toBe(3);
			expect(h.eventsOfType("compaction_end")[0]).toMatchObject({
				reason: "threshold",
				aborted: false,
				willRetry: true,
			});
		} finally {
			h.cleanup();
		}
	});
	it("blocks newly arriving over-budget user input before its first sample", async () => {
		const h = await createHarness({ model: { ...fauxModel, contextWindow: 64000 }, tools: [], responses: ["done"] });
		try {
			await expect(h.session.prompt("x".repeat(300000))).rejects.toMatchObject({
				name: "ContextBudgetBlockedError",
				reason: "nothing-to-compact",
			});
			expect(h.faux.callCount).toBe(0);
			expect(h.eventsOfType("compaction_start")).toHaveLength(0);
			expect(JSON.stringify(h.sessionManager.getEntries())).toContain("x".repeat(10000));
			expect(h.session.getRunStateSnapshot()).toMatchObject({
				state: "idle",
				terminalReason: "context-no-history-to-compact",
			});
		} finally {
			h.cleanup();
		}
	});
	it("keeps Main and delegated context limits independent", async () => {
		const settings = { contextWindow: { main: 256000, subagent: 64000 } };
		const main = await createHarness({ model: { ...fauxModel, contextWindow: 128000 }, settings });
		const sub = await createHarness({
			model: { ...fauxModel, contextWindow: 128000 },
			settings,
			resourceLoader: { ...createTestResourceLoader(), getAgentRole: () => "delegated" },
		});
		try {
			expect(main.session.effectiveContextWindow).toBe(128000);
			expect(sub.session.effectiveContextWindow).toBe(64000);
			expect(main.session.getContextBudgetSnapshot().autoCompactThresholdTokens).toBe(115200);
			expect(sub.session.getContextBudgetSnapshot().autoCompactThresholdTokens).toBe(57600);
		} finally {
			main.cleanup();
			sub.cleanup();
		}
	});
	it("preserves incoming input when pre-turn compaction fails", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 64000 },
			tools: [],
			responses: [{ stopReason: "aborted" }],
		});
		try {
			h.sessionManager.appendMessage({ role: "user", content: "old".repeat(100000), timestamp: 1 });
			h.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			await expect(h.session.prompt("new request must survive")).rejects.toThrow();
			expect(JSON.stringify(h.sessionManager.getEntries())).toContain("new request must survive");
			expect(h.faux.callCount).toBe(1);
			expect(h.session.isCompacting).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});
