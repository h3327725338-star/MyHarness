import type { AgentTool } from "@myharness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { WebDialogBridge } from "../src/modes/web/dialogs.ts";
import { NO_INTERACTIVE_UI_CODE } from "../src/tools/interaction/ask-user-question.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * Gap coverage for ask_user_question / todo_write through the real session
 * (W160-B1, see data/overnight-2026-10-10/tests-2c/gaps.md section 3). K1 pins
 * the sequential ordering of two todo_write calls from one assistant message,
 * and K2/K3 pin the ask path through a real session context: with a bound
 * browser UI the tool suspends and answers, without one it throws
 * NO_INTERACTIVE_UI instead of silently returning an empty answer.
 */

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("ask_user_question and todo_write through the real session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("K1: applies two todo_write calls from one assistant message in order", async () => {
		const harness = await createHarness({
			responses: [
				fauxAssistantMessage([
					fauxToolCall("todo_write", {
						todos: [{ content: "第一版", status: "pending" }],
					}),
					fauxToolCall("todo_write", {
						todos: [{ content: "第一版", status: "completed" }],
					}),
				]),
				fauxAssistantMessage("done"),
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("go");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((message) => message.toolName === "todo_write")).toBe(true);
		expect(textOf(toolResults[0])).toContain("[ ] 第一版");
		expect(textOf(toolResults[1])).toContain("[x] 第一版");
		expect(toolResults[1].details).toMatchObject({ counts: { total: 1, completed: 1 } });
	});

	it("K2: asks through the real session context after binding a browser ui", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const bridge = new WebDialogBridge();
		await harness.session.bindExtensions({
			uiContext: bridge.createExtensionUiContext({ getAllThemes: () => [] }),
			mode: "web",
		});
		const tool = harness.session.agent.state.tools.find(
			(candidate: AgentTool) => candidate.name === "ask_user_question",
		);
		expect(tool).toBeDefined();

		const pending = tool!.execute(
			"call-session-ask",
			{ questions: [{ question: "选哪个方案？", options: ["方案 A", "方案 B"] }] },
			undefined,
			undefined,
		);
		expect(bridge.requests).toHaveLength(1);
		expect(bridge.requests[0]).toMatchObject({
			kind: "select",
			title: "选哪个方案？",
			options: ["方案 A", "方案 B", "其他（自己输入）"],
		});
		expect(bridge.respond(bridge.requests[0].id, "方案 B")).toBe(true);
		const result = await pending;
		expect(textOf(result)).toBe("问题：选哪个方案？\n回答：方案 B");
		expect(bridge.requests).toHaveLength(0);
	});

	it("K3: throws NO_INTERACTIVE_UI through the real session context without a bound ui", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const tool = harness.session.agent.state.tools.find(
			(candidate: AgentTool) => candidate.name === "ask_user_question",
		);
		expect(tool).toBeDefined();

		const failure = await tool!
			.execute("call-session-ask-headless", { questions: [{ question: "选哪个？" }] }, undefined, undefined)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error & { code?: string }).code).toBe(NO_INTERACTIVE_UI_CODE);
	});
});
