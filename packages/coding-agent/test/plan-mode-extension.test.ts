import type { AgentMessage } from "@myharness/agent-core";
import type { AssistantMessage } from "@myharness/ai";
import { describe, expect, it, vi } from "vitest";
import planModeExtension from "../examples/extensions/plan-mode/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/extensions/compat/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type AgentResponseReadyHandler = (
	event: { type: "agent_response_ready"; messages: AgentMessage[] },
	ctx: ExtensionContext,
) => Promise<void> | void;

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function setup(options: { activeTools?: string[]; selectChoice?: string; editorText?: string } = {}) {
	let activeTools = options.activeTools ?? ["read", "bash", "edit", "write"];
	const commands = new Map<string, CommandHandler>();
	let agentResponseReadyHandler: AgentResponseReadyHandler | undefined;

	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const setActiveTools = vi.fn<ExtensionAPI["setActiveTools"]>((toolNames) => {
		activeTools = [...toolNames];
	});
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();

	const api = {
		registerFlag: vi.fn(),
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerShortcut: vi.fn(),
		on(event: string, handler: unknown) {
			if (event === "agent_response_ready") {
				agentResponseReadyHandler = handler as AgentResponseReadyHandler;
			}
		},
		getFlag: vi.fn(() => false),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools,
		sendMessage,
		sendUserMessage,
		appendEntry,
	} as unknown as ExtensionAPI;

	planModeExtension(api);

	const ctx = {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			select: vi.fn(async () => options.selectChoice),
			editor: vi.fn(async () => options.editorText),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: {
				fg: (_name: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
		sessionManager: { getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	async function runCommand(name: string): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command: ${name}`);
		await command("", ctx);
	}

	async function triggerAgentResponseReady(text: string): Promise<void> {
		if (!agentResponseReadyHandler) throw new Error("Missing agent_response_ready handler");
		await agentResponseReadyHandler({ type: "agent_response_ready", messages: [createAssistantMessage(text)] }, ctx);
	}

	return {
		activeTools: () => activeTools,
		appendEntry,
		ctx,
		runCommand,
		sendMessage,
		sendUserMessage,
		setActiveTools,
		triggerAgentResponseReady,
	};
}

describe("plan-mode example extension", () => {
	it("preserves custom active tools while toggling plan mode", async () => {
		const { activeTools, runCommand, setActiveTools } = setup({
			activeTools: ["read", "bash", "edit", "write", "echo_tool"],
		});

		await runCommand("plan");

		expect(activeTools()).toEqual(["read", "bash", "edit", "write", "echo_tool"]);
		expect(setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "edit", "write", "echo_tool"]);

		await runCommand("plan");

		expect(activeTools()).toEqual(["read", "bash", "edit", "write", "echo_tool"]);
		expect(setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "edit", "write", "echo_tool"]);
	});

	it("does not prompt when the assistant response contains no plan", async () => {
		const { ctx, runCommand, sendMessage, triggerAgentResponseReady } = setup();

		await runCommand("plan");
		await triggerAgentResponseReady("This file defines the command-line argument parser.");

		expect(ctx.ui.select).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("queues plan refinement as a follow-up user message", async () => {
		const { runCommand, sendUserMessage, triggerAgentResponseReady } = setup({
			selectChoice: "Edit the plan",
			editorText: "Add a regression test.",
		});

		await runCommand("plan");
		await triggerAgentResponseReady("Plan:\n1. Inspect the current implementation\n2. Add a regression test");

		expect(sendUserMessage).toHaveBeenCalledWith(
			"[EDIT REQUEST] The user wants to edit the plan. Re-state your understanding of the task incorporating these edits, then output the revised numbered plan.\n\nEdits: Add a regression test.",
			{ deliverAs: "followUp" },
		);
	});

	it("queues plan execution as a follow-up custom message", async () => {
		const { activeTools, runCommand, sendMessage, triggerAgentResponseReady } = setup({
			activeTools: ["read", "bash", "edit", "write", "echo_tool"],
			selectChoice: "Execute the plan (track progress)",
		});

		await runCommand("plan");
		await triggerAgentResponseReady("Plan:\n1. Inspect the current implementation\n2. Add a regression test");

		expect(activeTools()).toEqual(["read", "bash", "edit", "write", "echo_tool"]);
		expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "plan-mode-execute" }), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});
});
