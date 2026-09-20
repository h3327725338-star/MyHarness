/**
 * Plan Mode Extension
 *
 * Two-phase planning mode:
 *   Phase 1 (Understanding): Full tool access like default mode.
 *     AI confirms understanding, asks questions, describes investigation steps.
 *     Waits for user confirmation before proceeding.
 *   Phase 2 (Planning): After user confirms, AI investigates and outputs a
 *     numbered plan. Edit/write remain available; Bash is restricted by an
 *     allowlist. User can Execute, Edit, or Stay in plan mode.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to an inspection-command allowlist in Phase 2
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@myharness/agent-core";
import type { AssistantMessage, TextContent } from "@myharness/ai";
import type { ExtensionAPI, ExtensionContext } from "@myharness/coding-agent";
import { Key } from "@myharness/tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

type PlanPhase = "understanding" | "planning" | null;

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
	planPhase?: PlanPhase;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planPhase: PlanPhase = null;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in two-phase plan mode (full tools; Phase 2 Bash is allowlisted)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		// Phase 1 (understanding) uses the same full tool set as default mode.
		return getNormalModeTools(activeToolNames);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
			planPhase,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		planPhase = planModeEnabled ? "understanding" : null;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Phase 1 (understanding) — full tools available.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle two-phase plan mode (full tools; Phase 2 Bash is allowlisted)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode (Phase 2+ only;
	// Phase 1 "understanding" has full tool access like default mode).
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || planPhase === "understanding" || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.customType === "plan-phase2-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE");
				}
				if (Array.isArray(content)) {
					return !content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE"));
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		// Phase 1: Understanding (full tool access like default mode)
		if (planModeEnabled && planPhase === "understanding") {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE — PHASE 1: UNDERSTANDING]

你处于计划/讨论模式。所有工具均可用——权限与默认模式相同。
你拥有完整的 read、bash、edit、write 权限。

你的任务：
1. 仔细分析用户的要求
2. 确认你的理解——重述目标，说明假设
3. 列出你还不清楚的地方
4. 描述你计划接下来调查什么（例如"我会 grep 搜索 X"、"我会读取文件 Y"）

输出格式：
**我的理解：**
- 目标：[用户想要达成什么]
- 假设：[你的假设]

**疑问：**
- [你还不清楚的地方]

**下一步（等待确认后执行）：**
- [你会搜索/读取什么来理解代码库]

不要输出编号方案。等待用户确认你的理解或让你继续，再进入调查和方案阶段。`,
					display: false,
				},
			};
		}

		// Phase 2: Planning (AI investigates and outputs a numbered plan)
		if (planModeEnabled && planPhase === "planning") {
			return {
				message: {
					customType: "plan-phase2-context",
					content: `[PLAN MODE — PHASE 2: PLANNING]

你处于计划模式第二阶段。用户已确认你的理解。
现在调查代码库，创建一个详细的、分步骤的方案。

你拥有完整的工具权限——使用 read、grep、find、ls、bash 进行调查。
对每一步编号。每一步需说明：
- 你会使用什么工具
- 预期结果

在"Plan:"标题下输出编号步骤的方案：

Plan:
1. 第一步描述
2. 第二步描述
...

输出方案后，用户会选择执行、编辑或保留。
- 如果用户选择编辑：你会收到他们的修改意见。重新陈述你对该任务的理解
  （包含修改意见），然后输出修订后的编号方案。`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion, phase transitions, and plan mode UI only after
	// delayed Auto Review/Auto Memory output has been released to the transcript.
	pi.on("agent_response_ready", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		// Phase 1 → Phase 2 transition: AI confirmed understanding but no plan yet.
		// Move to planning phase so the next turn gets the Phase 2 prompt.
		if (planPhase === "understanding" && todoItems.length === 0) {
			planPhase = "planning";
			persistState();
			return;
		}

		if (todoItems.length === 0) return;

		// Phase 2: we have a plan — ensure we stay in planning phase
		if (planPhase === "understanding") {
			planPhase = "planning";
		}
		persistState();

		// Show plan steps and prompt for next action
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		// Edit loop: keep prompting until user chooses Execute or Stay
		while (true) {
			const choice = await ctx.ui.select("Plan mode — what next?", [
				"Execute the plan (track progress)",
				"Stay in plan mode",
				"Edit the plan",
			]);

			if (choice?.startsWith("Execute")) {
				const firstTodoItem = todoItems[0];
				if (!firstTodoItem) return;

				planModeEnabled = false;
				planPhase = null;
				executionMode = true;
				restoreNormalModeTools();
				updateStatus(ctx);
				persistState();

				const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
				const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
After completing a step, include a [DONE:n] tag in your response.`;
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendMessage(
					{ customType: "plan-mode-execute", content: execMessage, display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}

			if (choice === "Stay in plan mode") {
				return;
			}

			// "Edit the plan" — open editor, send edit as user message.
			// After AI responds with revised plan, agent_response_ready fires again → loops.
			if (choice === "Edit the plan") {
				const refinement = await ctx.ui.editor(
					"Edit the plan (describe changes, then the AI will re-state understanding and revise):",
					"",
				);
				if (refinement?.trim()) {
					pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
					pi.sendUserMessage(
						`[EDIT REQUEST] The user wants to edit the plan. Re-state your understanding of the task incorporating these edits, then output the revised numbered plan.\n\nEdits: ${refinement.trim()}`,
						{ deliverAs: "followUp" },
					);
				}
				return;
			}

			return;
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
			planPhase = planModeEntry.data.planPhase ?? planPhase;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
