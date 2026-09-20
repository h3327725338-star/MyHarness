import { fauxAssistantMessage } from "@myharness/ai";
import { describe, expect, it } from "vitest";
import { createHarness, fauxModel } from "./test-harness.ts";

function seed(h: Awaited<ReturnType<typeof createHarness>>, tokens: number) {
	h.sessionManager.appendMessage({ role: "user", content: "task", timestamp: 1 });
	const assistant = fauxAssistantMessage("work", { timestamp: 2 });
	assistant.usage = { ...assistant.usage, input: tokens, output: 0, totalTokens: tokens };
	h.sessionManager.appendMessage(assistant);
	h.agent.state.messages = h.sessionManager.buildSessionContext().messages;
}
function internals(h: Awaited<ReturnType<typeof createHarness>>) {
	return h.session as unknown as {
		_ensureContextBudget: () => Promise<{ status: string }>;
		_checkCompaction: (message: unknown) => Promise<boolean>;
	};
}
describe("Codex context lifecycle", () => {
	it("compacts once at the 90% pre-request threshold and recomputes usage", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			tools: [],
			responses: ["summary"],
		});
		try {
			seed(h, 90000);
			expect(h.session.getContextBudgetSnapshot().shouldAutoCompact).toBe(true);
			const result = await internals(h)._ensureContextBudget();
			expect(result.status).toBe("compacted");
			expect(h.faux.callCount).toBe(1);
			expect(h.session.getContextBudgetSnapshot().usageSource).toBe("post-compaction-estimated");
			await internals(h)._ensureContextBudget();
			expect(h.faux.callCount).toBe(1);
		} finally {
			h.cleanup();
		}
	});
	it("does not compact below the model threshold", async () => {
		const h = await createHarness({ model: { ...fauxModel, contextWindow: 100000 }, tools: [] });
		try {
			seed(h, 89999);
			expect((await internals(h)._ensureContextBudget()).status).toBe("ok");
			expect(h.faux.callCount).toBe(0);
		} finally {
			h.cleanup();
		}
	});
	it("keeps a successful compact result but blocks when its resulting context is still over budget", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			tools: [],
			responses: ["S".repeat(400000)],
		});
		try {
			seed(h, 90000);
			await expect(internals(h)._ensureContextBudget()).rejects.toMatchObject({
				name: "ContextBudgetBlockedError",
				reason: "still-over-budget",
			});
			expect(h.faux.callCount).toBe(1);
			const history = h.agent.state.messages;
			expect(JSON.stringify(history)).toContain("S".repeat(10000));
			expect(h.agent.state.messages).toBe(history);
		} finally {
			h.cleanup();
		}
	});
	it("ends completed answers instead of forcing continuation after compaction", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			tools: [],
			responses: [{ text: "done", usage: { input: 95000, totalTokens: 95000 } }],
		});
		try {
			await h.session.prompt("task");
			expect(h.faux.callCount).toBe(1);
			expect(h.eventsOfType("compaction_start")).toHaveLength(0);
			expect(h.session.isIdle).toBe(true);
		} finally {
			h.cleanup();
		}
	});
	it("leaves a normal provider overflow terminal rather than running legacy recovery", async () => {
		const h = await createHarness({ tools: [], responses: [{ error: "maximum context length exceeded" }] });
		try {
			await h.session.prompt("task");
			expect(h.faux.callCount).toBe(1);
			expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});
	it("blocks an over-budget request when automatic compaction is disabled", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			settings: { compaction: { enabled: false } },
			tools: [],
		});
		try {
			seed(h, 100000);
			await expect(internals(h)._ensureContextBudget()).rejects.toMatchObject({
				name: "ContextBudgetBlockedError",
				reason: "auto-compact-disabled",
			});
			expect(h.faux.callCount).toBe(0);
		} finally {
			h.cleanup();
		}
	});
	it("does not compact at the threshold when automatic compaction is disabled", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			settings: { compaction: { enabled: false } },
			tools: [],
		});
		try {
			seed(h, 90000);
			expect(h.session.getContextBudgetSnapshot().shouldAutoCompact).toBe(true);
			expect((await internals(h)._ensureContextBudget()).status).toBe("ok");
			expect(h.faux.callCount).toBe(0);
		} finally {
			h.cleanup();
		}
	});
	it("blocks when compaction completes but the resulting context is still over budget", async () => {
		const h = await createHarness({
			model: { ...fauxModel, contextWindow: 100000 },
			tools: [],
			responses: ["S".repeat(500000)],
		});
		try {
			seed(h, 100000);
			await expect(internals(h)._ensureContextBudget()).rejects.toMatchObject({
				name: "ContextBudgetBlockedError",
				reason: "still-over-budget",
			});
			expect(h.faux.callCount).toBe(1);
		} finally {
			h.cleanup();
		}
	});
	it("preserves history and releases the session when cancellation interrupts the request", async () => {
		const h = await createHarness({ tools: [], responses: [{ stopReason: "aborted" }] });
		try {
			seed(h, 120000);
			const before = h.sessionManager.getLeafId();
			await expect(internals(h)._ensureContextBudget()).rejects.toMatchObject({ name: "ContextBudgetBlockedError" });
			expect(h.sessionManager.getLeafId()).toBe(before);
			expect(h.session.isCompacting).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});
