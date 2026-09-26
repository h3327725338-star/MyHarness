import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Container } from "../../tui/src/tui.ts";

import {
	createInitialGitBaseline,
	initializeGitRepository,
	runGit,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
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

	test("does not turn a persisted checkpoint into an active decision phase", () => {
		const context = createLifecycleUIContext();
		context.hasPendingGitCheckpointDecision = () => true;

		expect(context.getTaskLifecyclePhase()).toBe("idle");
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

	test("keeps the terminal outcome visible while a decision selector is open", () => {
		const terminalOutcome = {
			state: "completed",
			activity: "任务完成",
			startedAt: 1,
			lastActivityAt: 2,
		};
		const taskStatusBar = { setState: vi.fn() };
		const context = {
			taskStatusBar,
			lastTerminalRunState: terminalOutcome,
		};
		const currentSnapshot = {
			state: "idle",
			activity: "",
			lastActivityAt: 3,
		};

		(InteractiveMode.prototype as any).syncTaskStatusBar.call(context, "awaiting_decision", currentSnapshot);

		expect(taskStatusBar.setState).toHaveBeenCalledWith(terminalOutcome, "awaiting_decision");
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

	test("sends the next message after a failed task even while a task checkpoint is still open", async () => {
		const context = createSubmitContext("idle", false);
		context.taskDecisionActive = false;
		context.hasPendingGitCheckpointDecision = vi.fn(() => true);
		context.maybeOfferGitVersionSave = vi.fn(async () => {});
		context.showExtensionSelector = vi.fn(async () => undefined);
		const received: string[] = [];
		context.onInputCallback = (text: string) => received.push(text);
		(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit("继续修复刚才的问题");

		expect(received).toEqual(["继续修复刚才的问题"]);
		expect(context.maybeOfferGitVersionSave).not.toHaveBeenCalled();
		expect(context.showExtensionSelector).not.toHaveBeenCalled();
		expect(context.hasPendingGitCheckpointDecision).not.toHaveBeenCalled();
		expect(context.editor.setText).not.toHaveBeenCalledWith("继续修复刚才的问题");
	});

	test.each([
		["/restore", "handleRestoreCommand"],
		["/undo", "handleUndoCommand"],
	])("routes %s to its explicit command instead of sending it to the Agent", async (command, handler) => {
		const context = createSubmitContext("idle", false);
		context.handleRestoreCommand = vi.fn(async () => {});
		context.handleUndoCommand = vi.fn(async () => {});
		context.onInputCallback = vi.fn();
		(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit(command);

		expect(context[handler]).toHaveBeenCalledOnce();
		expect(context.onInputCallback).not.toHaveBeenCalled();
	});

	test("puts a steer message back into the editor when sending fails", async () => {
		const context = createSubmitContext("main_agent", true);
		let editorText = "";
		context.editor.getText = () => editorText;
		context.editor.setText = vi.fn((text: string) => {
			editorText = text;
		});
		context.showError = vi.fn();
		context.promptUserInput = vi.fn(async () => {
			throw new Error("No API key");
		});
		context.restoreUnsentInput = (InteractiveMode.prototype as any).restoreUnsentInput;
		(InteractiveMode.prototype as any).setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit("adjust the repair");

		expect(editorText).toBe("adjust the repair");
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("No API key"));
	});
});

describe("InteractiveMode /undo", () => {
	function createRestoreContext(overrides: Record<string, unknown> = {}): any {
		const context: any = {
			session: { isStreaming: false, getGitCheckpoint: () => undefined },
			pendingStartupGitCheckpoint: undefined,
			getTaskLifecyclePhase: () => "idle",
			maybeOfferGitVersionSave: vi.fn(async () => {}),
			showStatus: vi.fn(),
			...overrides,
		};
		return context;
	}

	test("offers the decision for the open session checkpoint", async () => {
		const checkpoint = { id: "checkpoint-open", status: "created" };
		const context = createRestoreContext({
			session: { isStreaming: false, getGitCheckpoint: () => checkpoint },
		});

		await (InteractiveMode.prototype as any).handleUndoCommand.call(context);

		expect(context.maybeOfferGitVersionSave).toHaveBeenCalledWith(checkpoint);
	});

	test("falls back to a checkpoint left by an earlier run", async () => {
		const startup = { id: "checkpoint-startup", status: "created" };
		const context = createRestoreContext({ pendingStartupGitCheckpoint: startup });

		await (InteractiveMode.prototype as any).handleUndoCommand.call(context);

		expect(context.maybeOfferGitVersionSave).toHaveBeenCalledWith(startup);
	});

	test("explains when there is nothing to undo", async () => {
		const context = createRestoreContext({
			session: { isStreaming: false, getGitCheckpoint: () => ({ id: "done", status: "completed" }) },
		});

		await (InteractiveMode.prototype as any).handleUndoCommand.call(context);

		expect(context.maybeOfferGitVersionSave).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("没有可撤销"));
	});

	test("refuses to undo while a task is still running", async () => {
		const context = createRestoreContext({
			getTaskLifecyclePhase: () => "main_agent",
			session: { isStreaming: true, getGitCheckpoint: () => ({ id: "open", status: "created" }) },
		});

		await (InteractiveMode.prototype as any).handleUndoCommand.call(context);

		expect(context.maybeOfferGitVersionSave).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("/undo"));
	});
});

describe("InteractiveMode /restore (discard to HEAD)", () => {
	const directories: string[] = [];

	afterEach(() => {
		while (directories.length > 0) {
			rmSync(directories.pop()!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	});

	function createDirtyRepository(): string {
		const directory = mkdtempSync(join(tmpdir(), "myharness-restore-command-"));
		directories.push(directory);
		writeFileSync(join(directory, "tracked.txt"), "committed\n", "utf8");
		expect(initializeGitRepository(directory).ok).toBe(true);
		expect(runGit(directory, ["config", "--local", "core.autocrlf", "false"]).ok).toBe(true);
		expect(setLocalGitIdentity(directory, { name: "restore test", email: "restore@example.invalid" }).ok).toBe(true);
		expect(createInitialGitBaseline(directory).ok).toBe(true);
		writeFileSync(join(directory, "tracked.txt"), "dirty\n", "utf8");
		writeFileSync(join(directory, "untracked.txt"), "new\n", "utf8");
		return directory;
	}

	function createContext(directory: string, choice: string | undefined): any {
		const prototype = InteractiveMode.prototype as any;
		const context: any = {
			session: { isStreaming: false },
			getTaskLifecyclePhase: () => "idle",
			sessionManager: { getCwd: () => directory },
			runtimeHost: { services: { agentDir: join(directory, "..", "agent-home-outside") } },
			taskDecisionActive: false,
			showExtensionSelector: vi.fn(async () => choice),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
		context.withTaskDecision = prototype.withTaskDecision;
		return context;
	}

	test("shows what will be lost and discards it after confirmation", async () => {
		const directory = createDirtyRepository();
		const context = createContext(directory, "丢弃并退回最新提交");

		await (InteractiveMode.prototype as any).handleRestoreCommand.call(context);

		const [prompt] = context.showExtensionSelector.mock.calls[0];
		expect(prompt).toContain("tracked.txt");
		expect(prompt).toContain("untracked.txt");
		expect(prompt).toContain("无法撤销");
		expect(readFileSync(join(directory, "tracked.txt"), "utf8")).toBe("committed\n");
		expect(existsSync(join(directory, "untracked.txt"))).toBe(false);
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("已退回到最新提交"));
		expect(context.taskDecisionActive).toBe(false);
	});

	test("leaves the workspace untouched when cancelled", async () => {
		const directory = createDirtyRepository();
		const context = createContext(directory, undefined);

		await (InteractiveMode.prototype as any).handleRestoreCommand.call(context);

		expect(readFileSync(join(directory, "tracked.txt"), "utf8")).toBe("dirty\n");
		expect(existsSync(join(directory, "untracked.txt"))).toBe(true);
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("已取消"));
	});

	test("refuses while a task is running without touching Git", async () => {
		const directory = createDirtyRepository();
		const context = createContext(directory, "丢弃并退回最新提交");
		context.getTaskLifecyclePhase = () => "main_agent";
		context.session.isStreaming = true;

		await (InteractiveMode.prototype as any).handleRestoreCommand.call(context);

		expect(context.showExtensionSelector).not.toHaveBeenCalled();
		expect(readFileSync(join(directory, "tracked.txt"), "utf8")).toBe("dirty\n");
	});
});
