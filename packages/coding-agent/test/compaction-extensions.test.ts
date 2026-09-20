import { describe, expect, it } from "vitest";
import { createHarnessWithExtensions } from "./test-harness.ts";

describe("Codex compaction lifecycle hooks", () => {
	it("emits before and after hooks with the committed replacement history", async () => {
		const seen: string[] = [];
		const h = await createHarnessWithExtensions({
			responses: ["summary"],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						expect(event.preparation.messagesToSummarize).toHaveLength(1);
						seen.push("before");
					});
					pi.on("session_compact", async (event) => {
						expect(event.compactionEntry.replacementHistory).toHaveLength(2);
						expect(event.fromExtension).toBe(false);
						seen.push("after");
					});
				},
			],
		});
		try {
			h.sessionManager.appendMessage({ role: "user", content: "task", timestamp: 1 });
			h.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			await h.session.compact();
			expect(seen).toEqual(["before", "after"]);
		} finally {
			h.cleanup();
		}
	});
	it("honors cancellation without generating or persisting a checkpoint", async () => {
		const h = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		try {
			h.sessionManager.appendMessage({ role: "user", content: "task", timestamp: 1 });
			h.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			await expect(h.session.compact()).rejects.toThrow("cancelled");
			expect(h.faux.callCount).toBe(0);
			expect(h.session.isCompacting).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});
