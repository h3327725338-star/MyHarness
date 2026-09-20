import { describe, expect, test, vi } from "vitest";

import { Container } from "../../tui/src/tui.ts";

import { IdleStatus } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	deriveTaskLifecyclePhase,
	isTaskLifecycleBusy,
	type TaskLifecycleInputs,
} from "../src/modes/interactive/task-lifecycle.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function renderAll(container: Container, width = 180): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function createLifecycleUIContext(overrides: Partial<Record<string, unknown>> = {}): any {
	const prototype = InteractiveMode.prototype as any;
	const context: any = {
		session: { isStreaming: false },
		completionWorkflowActive: false,
		completionWorkflowPromise: undefined,
		taskDecisionActive: false,
		lastRenderedTaskLifecyclePhase: undefined,
		workingVisible: true,
		workingMessage: undefined,
		defaultWorkingMessage: "Working...",
		workingIndicatorOptions: undefined,
		statusIndicators: new Map(),
		statusContainer: new Container(),
		idleStatus: new IdleStatus(),
		ui: {
			getClearOnShrink: () => false,
			requestRender: vi.fn(),
			terminal: { setProgress: vi.fn() },
		},
		settingsManager: { getShowTerminalProgress: () => true },
	};
	Object.assign(context, overrides);
	context.getTaskLifecyclePhase = prototype.getTaskLifecyclePhase;
	context.getWorkingStatusIndicator = prototype.getWorkingStatusIndicator;
	context.renderStatusIndicators = prototype.renderStatusIndicators;
	context.showStatusIndicator = prototype.showStatusIndicator;
	context.clearStatusIndicator = prototype.clearStatusIndicator;
	context.syncTaskStatusBar = vi.fn();
	context.syncTaskLifecycleUI = prototype.syncTaskLifecycleUI;
	return context;
}

describe("Task lifecycle derivation", () => {
	const lifecycleCases: Array<[string, TaskLifecycleInputs]> = [
		[
			"idle",
			{
				agentIsStreaming: false,
				completionWorkflowActive: false,
				completionWorkflowPending: false,
				taskDecisionActive: false,
			},
		],
		[
			"main_agent",
			{
				agentIsStreaming: true,
				completionWorkflowActive: false,
				completionWorkflowPending: false,
				taskDecisionActive: false,
			},
		],
		[
			"completion",
			{
				agentIsStreaming: false,
				completionWorkflowActive: true,
				completionWorkflowPending: false,
				taskDecisionActive: false,
			},
		],
		[
			"completion",
			{
				agentIsStreaming: false,
				completionWorkflowActive: false,
				completionWorkflowPending: true,
				taskDecisionActive: false,
			},
		],
		[
			"awaiting_decision",
			{
				agentIsStreaming: false,
				completionWorkflowActive: true,
				completionWorkflowPending: true,
				taskDecisionActive: true,
			},
		],
		[
			"awaiting_decision",
			{
				agentIsStreaming: false,
				completionWorkflowActive: false,
				completionWorkflowPending: false,
				taskDecisionActive: false,
				checkpointDecisionPending: true,
			},
		],
	];

	test.each(lifecycleCases)("derives %s from authoritative inputs", (expected, inputs) => {
		expect(deriveTaskLifecyclePhase(inputs)).toBe(expected);
	});

	test("only execution phases are busy", () => {
		expect(isTaskLifecycleBusy("idle")).toBe(false);
		expect(isTaskLifecycleBusy("awaiting_decision")).toBe(false);
		expect(isTaskLifecycleBusy("main_agent")).toBe(true);
		expect(isTaskLifecycleBusy("completion")).toBe(true);
	});

	test("keeps a terminal failure visible during completion cleanup", () => {
		const terminalFailure = {
			state: "failed",
			activity: "任务失败",
			startedAt: 1,
			lastActivityAt: 2,
			error: "request failed",
		};
		const taskStatusBar = { setState: vi.fn() };
		const context = {
			taskStatusBar,
			lastTerminalRunState: terminalFailure,
		};
		const currentSnapshot = {
			state: "idle",
			activity: "",
			lastActivityAt: 3,
		};

		(InteractiveMode.prototype as any).syncTaskStatusBar.call(context, "completion", currentSnapshot);

		expect(taskStatusBar.setState).toHaveBeenCalledWith(terminalFailure, "completion");
	});
});

describe("InteractiveMode task lifecycle UI", () => {
	test("shows completion progress and stops busy state for a decision", () => {
		initTheme("dark");
		const context = createLifecycleUIContext({ completionWorkflowActive: true });

		context.syncTaskLifecycleUI.call(context);
		expect(renderAll(context.statusContainer)).toContain("Finishing task...");
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		const renderCount = context.statusContainer.children.length;
		context.syncTaskLifecycleUI.call(context);
		expect(context.statusContainer.children).toHaveLength(renderCount);

		context.taskDecisionActive = true;
		context.syncTaskLifecycleUI.call(context);
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
		expect(renderAll(context.statusContainer)).not.toContain("Finishing task...");

		context.taskDecisionActive = false;
		context.completionWorkflowActive = false;
		context.completionWorkflowPromise = undefined;
		context.syncTaskLifecycleUI.call(context);
		expect(context.statusContainer.children).toHaveLength(0);
	});
});

describe("InteractiveMode task-level input boundary", () => {
	function createSubmitContext(phase: string, streaming: boolean): any {
		return {
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session: {
				isCompacting: false,
				isStreaming: streaming,
				isBashRunning: false,
				prompt: vi.fn(async () => {}),
			},
			flushPendingBashComponents: vi.fn(),
			recordSlashCommandUsage: vi.fn(),
			getTaskLifecyclePhase: () => phase,
			promptUserInput: vi.fn(async () => {}),
			completionWorkflowActive: phase === "completion",
			pendingUserInputs: [],
			showStatus: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
	}

	test("queues a normal prompt during completion", async () => {
		const context = createSubmitContext("completion", false);
		(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit("next question");

		expect(context.pendingUserInputs).toEqual(["next question"]);
		expect(context.promptUserInput).not.toHaveBeenCalled();
	});

	test("keeps a streaming turn in the Agent steer queue", async () => {
		const context = createSubmitContext("main_agent", true);
		(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit("adjust the repair");

		expect(context.promptUserInput).toHaveBeenCalledWith("adjust the repair", { streamingBehavior: "steer" });
		expect(context.pendingUserInputs).toHaveLength(0);
	});
});
