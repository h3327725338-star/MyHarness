import { describe, expect, it } from "vitest";
import { createHarness } from "./test-harness.ts";

describe("Codex execution continuity", () => {
	it("includes complete tool evidence in the compaction request and replaces tool history with the summary", async () => {
		const h = await createHarness({ responses: ["Verified tools and saved artifacts."] });
		try {
			h.sessionManager.appendMessage({ role: "user", content: "inspect project", timestamp: 1 });
			h.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "evidence /tmp/artifact" }],
				isError: false,
				timestamp: 2,
			});
			h.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			await h.session.compact();
			expect(JSON.stringify(h.faux.contexts[0])).toContain("evidence /tmp/artifact");
			expect(h.agent.state.messages.every((message) => message.role === "user")).toBe(true);
			expect(JSON.stringify(h.agent.state.messages)).toContain("Verified tools and saved artifacts.");
			expect(h.sessionManager.getBranch().at(-1)).not.toHaveProperty("details.executions");
			await h.session.compact();
			expect(JSON.stringify(h.faux.contexts[1])).toContain("Verified tools and saved artifacts.");
		} finally {
			h.cleanup();
		}
	});
});
