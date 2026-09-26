import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import * as path from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@myharness/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";

import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { SourceInfo } from "../src/extensions/contracts/source-info.ts";
import type { AutocompleteProviderFactory } from "../src/extensions/runtime/types.ts";
import {
	createInitialGitBaseline,
	initializeGitRepository,
	inspectGitRepository,
	setLocalGitIdentity,
} from "../src/git/repository/integration.ts";
import { IdleStatus, WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// maybeStartCompletionWorkflow 以 Final ChangeSet（collectFinalWorkspaceChanges）
// 为事实来源；completion gate 测试通过 mock 该入口控制检测结果。
const completionGateMocks = vi.hoisted(() => ({
	collectFinalWorkspaceChanges: vi.fn(),
}));

vi.mock("../src/git/repository/workspace-changes.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/git/repository/workspace-changes.ts")>();
	return { ...actual, collectFinalWorkspaceChanges: completionGateMocks.collectFinalWorkspaceChanges };
});

// Git checkpoint 生命周期：mock 模块级入口，便于直接驱动
// settleFailedTaskGitCheckpoint / notifyPendingGitCheckpoints / maybeOfferGitVersionSave 的分支。
const checkpointMocks = vi.hoisted(() => ({
	listGitCheckpoints: vi.fn(),
	hasGitCheckpointTaskChanges: vi.fn(),
	hasGitCheckpointTaskChangesAsync: vi.fn(),
	restoreGitCheckpoint: vi.fn(),
	getGitCheckpointPendingTaskPaths: vi.fn(),
	getGitCheckpointPendingTaskPathsAsync: vi.fn(),
	getGitWorkingTreePathsAsync: vi.fn(),
}));

vi.mock("../src/git/checkpoints/checkpoint.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/git/checkpoints/checkpoint.ts")>();
	return {
		...actual,
		listGitCheckpoints: checkpointMocks.listGitCheckpoints,
		hasGitCheckpointTaskChanges: checkpointMocks.hasGitCheckpointTaskChanges,
		hasGitCheckpointTaskChangesAsync: checkpointMocks.hasGitCheckpointTaskChangesAsync,
		restoreGitCheckpoint: checkpointMocks.restoreGitCheckpoint,
		getGitCheckpointPendingTaskPaths: checkpointMocks.getGitCheckpointPendingTaskPaths,
		getGitCheckpointPendingTaskPathsAsync: checkpointMocks.getGitCheckpointPendingTaskPathsAsync,
		getGitWorkingTreePathsAsync: checkpointMocks.getGitWorkingTreePathsAsync,
	};
});

// “本地提交更改”自动修复流程：mock 提交信息生成与 git 提交入口。
const gitCommitMocks = vi.hoisted(() => ({
	createGitCommitForPaths: vi.fn(),
	createGitCommitForPathsAsync: vi.fn(),
	generateCommitMessageForPaths: vi.fn(),
	generateCommitMessageForPathsAsync: vi.fn(),
}));

vi.mock("../src/git/repository/integration.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/git/repository/integration.ts")>();
	return {
		...actual,
		createGitCommitForPaths: gitCommitMocks.createGitCommitForPaths,
		createGitCommitForPathsAsync: gitCommitMocks.createGitCommitForPathsAsync,
	};
});

vi.mock("../src/git/commits/message.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/git/commits/message.ts")>();
	return {
		...actual,
		generateCommitMessageForPaths: gitCommitMocks.generateCommitMessageForPaths,
		generateCommitMessageForPathsAsync: gitCommitMocks.generateCommitMessageForPathsAsync,
	};
});

function makeCreatedCheckpoint(id: string) {
	return {
		id,
		status: "created",
		headCommit: "h1",
		headRef: "refs/heads/main",
		storagePath: `/tmp/${id}`,
	};
}

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode status display", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("keeps transient status out of the chat transcript", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			transientStatusContainer: new Container(),
			transientStatusText: undefined,
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(0);
		expect(fakeThis.transientStatusContainer.children).toHaveLength(1);
		expect(renderLastLine(fakeThis.transientStatusContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		expect(fakeThis.chatContainer.children).toHaveLength(0);
		expect(fakeThis.transientStatusContainer.children).toHaveLength(1);
		expect(renderLastLine(fakeThis.transientStatusContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.transientStatusContainer)).not.toContain("STATUS_ONE");
	});

	test("shows independent status indicators without replacing another kind", () => {
		const disposed: string[] = [];
		const fakeThis: any = {
			statusIndicators: new Map(),
			statusContainer: new Container(),
			idleStatus: new IdleStatus(),
			ui: { getClearOnShrink: () => false },
			renderStatusIndicators: (InteractiveMode as any).prototype.renderStatusIndicators,
		};
		const indicator = (kind: string) => ({
			kind,
			dispose: () => disposed.push(kind),
			render: () => [kind],
		});

		(InteractiveMode as any).prototype.showStatusIndicator.call(fakeThis, indicator("working"));
		(InteractiveMode as any).prototype.showStatusIndicator.call(fakeThis, indicator("retry"));
		expect(renderAll(fakeThis.statusContainer)).toContain("working");
		expect(renderAll(fakeThis.statusContainer)).toContain("retry");

		(InteractiveMode as any).prototype.clearStatusIndicator.call(fakeThis, "retry");
		expect(renderAll(fakeThis.statusContainer)).toContain("working");
		expect(renderAll(fakeThis.statusContainer)).not.toContain("retry");
		expect(disposed).toEqual(["retry"]);
	});

	test("working status shows activity, elapsed time, and a live heartbeat", () => {
		vi.useFakeTimers();
		try {
			const indicator = new WorkingStatusIndicator({ requestRender: vi.fn() } as any, "Working...");
			indicator.markActivity("正在运行工具：bash");
			expect(stripAnsi(indicator.render(160).join("\n"))).toContain(
				"Working... · 正在运行工具：bash · 已运行 0s · 最近活动 0s 前",
			);

			vi.advanceTimersByTime(3000);
			const output = stripAnsi(indicator.render(160).join("\n"));
			expect(output).toContain("已运行 3s");
			expect(output).toContain("最近活动 3s 前");
			indicator.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("shows the Git checkpoint preparation lifecycle", async () => {
		const messages: string[] = [];
		const warnings: string[] = [];
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			showStatus: (message: string) => messages.push(message),
			showWarning: (message: string) => warnings.push(message),
			markWorkingActivity: vi.fn(),
		};

		const handleEvent = (InteractiveMode as any).prototype.handleEvent;
		await handleEvent.call(fakeThis, { type: "git_checkpoint_start" });
		await handleEvent.call(fakeThis, {
			type: "git_checkpoint_end",
			ok: true,
			checkpointId: "checkpoint-test",
		});
		await handleEvent.call(fakeThis, { type: "git_checkpoint_start" });
		await handleEvent.call(fakeThis, { type: "git_checkpoint_end", ok: false, error: "test failure" });

		expect(messages).toEqual([
			"Git：正在创建任务检查点…",
			"Git：已创建任务检查点 checkpoint-test。",
			"Git：正在创建任务检查点…",
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Agent 会继续执行");
		expect(warnings[0]).toContain("test failure");
	});

	test("processes asynchronous agent events strictly in arrival order", async () => {
		const order: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const fakeThis: any = {
			eventProcessingQueue: Promise.resolve(),
			eventSubscriptionGeneration: 1,
			handleEvent: async (event: { type: string }) => {
				order.push(`start:${event.type}`);
				if (event.type === "first") await firstBlocked;
				order.push(`end:${event.type}`);
			},
			showError: vi.fn(),
		};
		const enqueue = (InteractiveMode as any).prototype.enqueueAgentEvent;
		enqueue.call(fakeThis, { type: "first" }, 1);
		enqueue.call(fakeThis, { type: "second" }, 1);
		await Promise.resolve();
		expect(order).toEqual(["start:first"]);

		releaseFirst?.();
		await fakeThis.eventProcessingQueue;
		expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
	});
});

describe("InteractiveMode completion gate", () => {
	beforeEach(() => {
		completionGateMocks.collectFinalWorkspaceChanges.mockReset();
		completionGateMocks.collectFinalWorkspaceChanges.mockResolvedValue({
			status: "known",
			changes: [{ path: "src/a.ts", status: "modified" }],
		});
		checkpointMocks.listGitCheckpoints.mockReset();
		checkpointMocks.hasGitCheckpointTaskChanges.mockReset();
		checkpointMocks.hasGitCheckpointTaskChanges.mockReturnValue(true);
		checkpointMocks.hasGitCheckpointTaskChangesAsync.mockReset();
		checkpointMocks.hasGitCheckpointTaskChangesAsync.mockResolvedValue(true);
		checkpointMocks.restoreGitCheckpoint.mockReset();
		checkpointMocks.getGitCheckpointPendingTaskPaths.mockReset();
		checkpointMocks.getGitCheckpointPendingTaskPaths.mockReturnValue({ paths: ["src/a.ts"] });
		checkpointMocks.getGitCheckpointPendingTaskPathsAsync.mockReset();
		checkpointMocks.getGitCheckpointPendingTaskPathsAsync.mockResolvedValue({ paths: ["src/a.ts"] });
		checkpointMocks.getGitWorkingTreePathsAsync.mockReset();
		checkpointMocks.getGitWorkingTreePathsAsync.mockResolvedValue({ paths: ["src/a.ts"] });
		gitCommitMocks.createGitCommitForPaths.mockReset();
		gitCommitMocks.createGitCommitForPathsAsync.mockReset();
		gitCommitMocks.generateCommitMessageForPaths.mockReset();
		gitCommitMocks.generateCommitMessageForPathsAsync.mockReset();
		gitCommitMocks.generateCommitMessageForPathsAsync.mockResolvedValue({
			title: "fix: 修复测试问题",
			body: ["- M src/a.ts"],
			full: "fix: 修复测试问题\n\n- M src/a.ts",
		});
	});

	test("delays assistant output only when memory is pending", () => {
		const fakeThis: any = {
			completionWorkflowActive: false,
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
			},
		};
		const shouldDelay = (InteractiveMode as any).prototype.shouldDelayAssistantOutput;

		expect(shouldDelay.call(fakeThis)).toBe(false);
		fakeThis.settingsManager.getAutoMemorySettings = () => ({ enabled: true });
		expect(shouldDelay.call(fakeThis)).toBe(true);
	});

	test("runs memory, then publishes the buffered final response", async () => {
		const calls: string[] = [];
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: true }),
				getGitIntegrationSettings: () => ({ enabled: false }),
			},
			ensureWorkspaceBaseline: async () => undefined,
			workspaceBaselineFailureReason: undefined,
			session: {
				getGitCheckpoint: () => undefined,
				runAutoMemoryExtraction: async () => {
					calls.push("memory");
					return true;
				},
				completeGitCheckpointAfterVerification: () => ({ ok: true }),
				extensionRunner: {
					emit: async (event: { type: string }) => {
						if (event.type === "agent_response_ready") calls.push("ready");
					},
				},
			},
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			publishBufferedAssistantMessage: () => calls.push("publish"),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		fakeThis.settleFailedTaskGitCheckpoint = vi.fn(async () => {});

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(calls).toEqual(["memory", "publish", "ready"]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("shows the assistant response before opening response-dependent extension UI", async () => {
		const calls: string[] = [];
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
				getGitIntegrationSettings: () => ({ enabled: false }),
			},
			ensureWorkspaceBaseline: async () => undefined,
			workspaceBaselineFailureReason: undefined,
			session: {
				getGitCheckpoint: () => undefined,
				completeGitCheckpointAfterVerification: () => ({ ok: true }),
				extensionRunner: {
					emit: async (event: { type: string }) => {
						if (event.type === "agent_response_ready") calls.push("menu");
					},
				},
			},
			publishBufferedAssistantMessage: () => calls.push("publish"),
			showError: vi.fn(),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		fakeThis.settleFailedTaskGitCheckpoint = vi.fn(async () => {});

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(calls).toEqual(["publish", "menu"]);
	});

	test("publishes the response without automatically starting a local Git commit", async () => {
		const calls: string[] = [];
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
				getGitIntegrationSettings: () => ({ enabled: true }),
			},
			session: {
				getGitCheckpoint: () => undefined,
				completeGitCheckpointAfterVerification: () => ({ ok: true }),
				extensionRunner: {
					emit: async (event: { type: string }) => {
						if (event.type === "agent_response_ready") calls.push("ready");
					},
				},
			},
			publishBufferedAssistantMessage: () => calls.push("publish"),
			maybeHandleGitSaveAfterCompletion: vi.fn(async () => calls.push("git")),
			showError: vi.fn(),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		fakeThis.settleFailedTaskGitCheckpoint = vi.fn(async () => {});

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(calls).toEqual(["publish", "ready"]);
		expect(fakeThis.maybeHandleGitSaveAfterCompletion).not.toHaveBeenCalled();
	});

	test("leaves dirty checkpoint changes for explicit /commit instead of auto-starting", async () => {
		const checkpoint = makeCreatedCheckpoint("checkpoint-awaiting-commit");
		const complete = vi.fn(() => ({ ok: true }));
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
				getGitIntegrationSettings: () => ({ enabled: true }),
			},
			session: {
				getGitCheckpoint: () => checkpoint,
				completeGitCheckpointAfterVerification: complete,
				extensionRunner: { emit: async () => {} },
			},
			clearGitCommitTask: vi.fn(),
			startGitCommitTask: vi.fn(),
			showStatus: vi.fn(),
			publishBufferedAssistantMessage: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			settleFailedTaskGitCheckpoint: vi.fn(async () => {}),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		completionGateMocks.collectFinalWorkspaceChanges.mockResolvedValue({
			status: "known",
			changes: [{ path: "src/a.ts", status: "modified" }],
			git: { gitSave: "pending", hasTaskChanges: true },
		});

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(fakeThis.startGitCommitTask).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("/commit"));
	});

	test("does not offer a duplicate Git Save after an Agent-authorized commit already satisfied it", async () => {
		const checkpoint = makeCreatedCheckpoint("checkpoint-agent-committed");
		const complete = vi.fn(() => ({ ok: true }));
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
				getGitIntegrationSettings: () => ({ enabled: true }),
			},
			session: {
				getGitCheckpoint: () => checkpoint,
				completeGitCheckpointAfterVerification: complete,
				extensionRunner: { emit: async () => {} },
			},
			recordCheckpointReviewState: vi.fn(async () => true),
			clearGitCommitTask: vi.fn(),
			publishBufferedAssistantMessage: vi.fn(),
			maybeOfferGitVersionSave: vi.fn(async () => {}),
			settleFailedTaskGitCheckpoint: vi.fn(async () => {}),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		completionGateMocks.collectFinalWorkspaceChanges.mockResolvedValue({
			status: "known",
			changes: [{ path: "src/a.ts", status: "modified" }],
			git: {
				hasTaskChanges: true,
				headChanged: true,
				pendingPaths: [],
				gitSave: "satisfied",
				remoteSideEffects: false,
				historyOnly: false,
			},
		});

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(complete).toHaveBeenCalledWith();
		expect(fakeThis.maybeOfferGitVersionSave).not.toHaveBeenCalled();
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	function createFailedRunContext(checkpoint: any, retain = vi.fn()): any {
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			clearStatusIndicator: vi.fn(),
			streamingComponent: undefined,
			streamingComponentAttached: false,
			chatContainer: { removeChild: vi.fn() },
			streamingMessage: undefined,
			delayStreamingAssistant: false,
			pendingTools: new Map(),
			activeToolNames: new Set(),
			clearTransientStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
			taskDecisionActive: false,
			closeRecoveryCheckpoint: (InteractiveMode as any).prototype.closeRecoveryCheckpoint,
			clearGitCommitTask: vi.fn(),
			session: {
				getGitCheckpoint: () => checkpoint,
				retainGitCheckpointWithoutVerification: retain,
			},
			showExtensionSelector: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			pendingResponseReadyMessages: [],
			checkShutdownRequested: vi.fn(async () => {}),
		};
		fakeThis.settleFailedTaskGitCheckpoint = (InteractiveMode as any).prototype.settleFailedTaskGitCheckpoint;
		return fakeThis;
	}

	test.each(["error", "aborted"])(
		"after a %s run with task changes, keeps the workspace and checkpoint without any selector",
		async (stopReason) => {
			initTheme("dark");
			const checkpoint = makeCreatedCheckpoint(`checkpoint-${stopReason}`);
			const retain = vi.fn();
			const fakeThis = createFailedRunContext(checkpoint, retain);

			await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason }],
				willRetry: false,
			});
			await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, { type: "agent_settled" });

			expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
			expect(checkpointMocks.restoreGitCheckpoint).not.toHaveBeenCalled();
			expect(retain).not.toHaveBeenCalled();
			expect(checkpoint.status).toBe("created");
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("/undo"));
			expect(fakeThis.taskSettlementPending).toBe(false);
			expect(fakeThis.pendingResponseReadyMessages).toEqual([]);
		},
	);

	test("after a failed run without task changes, closes the checkpoint silently", async () => {
		initTheme("dark");
		checkpointMocks.hasGitCheckpointTaskChangesAsync.mockResolvedValue(false);
		const checkpoint = makeCreatedCheckpoint("checkpoint-no-changes");
		const retain = vi.fn((cp: any) => {
			cp.status = "retained";
			return { ok: true };
		});
		const fakeThis = createFailedRunContext(checkpoint, retain);

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
			willRetry: false,
		});
		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, { type: "agent_settled" });

		expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
		expect(retain).toHaveBeenCalledWith(checkpoint);
		expect(checkpoint.status).toBe("retained");
	});

	test("a Git error while checking the failed run's checkpoint still settles the task", async () => {
		initTheme("dark");
		checkpointMocks.hasGitCheckpointTaskChangesAsync.mockRejectedValue(new Error("fatal: adding files failed"));
		const checkpoint = makeCreatedCheckpoint("checkpoint-git-broken");
		const fakeThis = createFailedRunContext(checkpoint);

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "error" }],
			willRetry: false,
		});
		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, { type: "agent_settled" });

		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("fatal: adding files failed"));
		expect(fakeThis.taskSettlementPending).toBe(false);
		expect(checkpoint.status).toBe("created");
		expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
	});

	test("a rejected prompt settles the checkpoint without a selector and still reports the error", async () => {
		initTheme("dark");
		const checkpoint = makeCreatedCheckpoint("checkpoint-prompt-rejected");
		const fakeThis = createFailedRunContext(checkpoint);
		fakeThis.collectInputImages = async () => [];
		fakeThis.session.prompt = vi.fn(async () => {
			throw new Error("Provider unavailable");
		});

		await expect((InteractiveMode as any).prototype.promptUserInput.call(fakeThis, "next message")).rejects.toThrow(
			"Provider unavailable",
		);
		expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
		expect(checkpoint.status).toBe("created");
	});

	test("startup reports an unfinished checkpoint instead of opening a selector", async () => {
		initTheme("dark");
		const loaded = makeCreatedCheckpoint("checkpoint-loaded");
		const fakeThis = createFailedRunContext(undefined);
		fakeThis.sessionManager = { getCwd: () => process.cwd(), getSessionId: () => "session" };
		fakeThis.pendingStartupGitCheckpoint = undefined;
		fakeThis.clearPendingStartupGitCheckpoint = (InteractiveMode as any).prototype.clearPendingStartupGitCheckpoint;
		checkpointMocks.listGitCheckpoints.mockReturnValue({ ok: true, checkpoints: [loaded], failed: [] });

		await (InteractiveMode as any).prototype.notifyPendingGitCheckpoints.call(fakeThis);

		expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
		expect(fakeThis.pendingStartupGitCheckpoint).toBe(loaded);
		expect(loaded.status).toBe("created");
		expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("/undo"));
	});

	test("startup closes empty unfinished checkpoints without keeping them pending", async () => {
		initTheme("dark");
		checkpointMocks.hasGitCheckpointTaskChangesAsync.mockResolvedValue(false);
		const loaded = makeCreatedCheckpoint("checkpoint-loaded-empty");
		const retain = vi.fn((cp: any) => {
			cp.status = "retained";
			return { ok: true };
		});
		const fakeThis = createFailedRunContext(undefined, retain);
		fakeThis.sessionManager = { getCwd: () => process.cwd(), getSessionId: () => "session" };
		fakeThis.clearPendingStartupGitCheckpoint = (InteractiveMode as any).prototype.clearPendingStartupGitCheckpoint;
		checkpointMocks.listGitCheckpoints.mockReturnValue({ ok: true, checkpoints: [loaded], failed: [] });

		await (InteractiveMode as any).prototype.notifyPendingGitCheckpoints.call(fakeThis);

		expect(retain).toHaveBeenCalledWith(loaded);
		expect(fakeThis.pendingStartupGitCheckpoint).toBeUndefined();
	});

	describe("explicit /restore decision", () => {
		let repositoryRoot = "";

		beforeAll(() => {
			const directory = mkdtempSync(path.join(tmpdir(), "myharness-restore-decision-"));
			writeFileSync(path.join(directory, "a.txt"), "a\n", "utf8");
			expect(initializeGitRepository(directory).ok).toBe(true);
			expect(setLocalGitIdentity(directory, { name: "restore test", email: "restore@example.invalid" }).ok).toBe(
				true,
			);
			expect(createInitialGitBaseline(directory).ok).toBe(true);
			repositoryRoot = inspectGitRepository(directory).root!;
		});

		function createRestoreDecisionContext(choice: string | undefined, checkpoint: any): any {
			const fakeThis: any = {
				taskDecisionActive: false,
				pendingResponseReadyMessages: [{ role: "assistant" }],
				sessionManager: { getCwd: () => repositoryRoot },
				session: {
					getGitCheckpoint: () => checkpoint,
					retainGitCheckpointWithoutVerification: vi.fn((cp: any) => {
						cp.status = "retained";
						return { ok: true };
					}),
					invalidateGitCheckpointRecovery: vi.fn((cp: any, reason: string) => {
						cp.status = "invalid";
						cp.failureReason = reason;
						return { ok: true };
					}),
				},
				clearGitCommitTask: vi.fn(),
				showExtensionSelector: vi.fn(async () => choice),
				showError: vi.fn(),
				showWarning: vi.fn(),
				showStatus: vi.fn(),
			};
			const prototype = (InteractiveMode as any).prototype;
			fakeThis.withTaskDecision = prototype.withTaskDecision;
			fakeThis.failGitCheckpointRecovery = prototype.failGitCheckpointRecovery;
			fakeThis.clearPendingStartupGitCheckpoint = prototype.clearPendingStartupGitCheckpoint;
			return fakeThis;
		}

		function restoreCheckpoint(id: string): any {
			return { ...makeCreatedCheckpoint(id), repositoryRoot };
		}

		test("restores the checkpoint when the user explicitly chooses restore", async () => {
			initTheme("dark");
			const checkpoint = restoreCheckpoint("checkpoint-restore");
			const fakeThis = createRestoreDecisionContext("恢复任务更改", checkpoint);
			checkpointMocks.restoreGitCheckpoint.mockResolvedValue({ ok: true });

			await (InteractiveMode as any).prototype.maybeOfferGitVersionSave.call(fakeThis, checkpoint);

			expect(fakeThis.showExtensionSelector).toHaveBeenCalledOnce();
			expect(checkpointMocks.restoreGitCheckpoint).toHaveBeenCalledWith(checkpoint);
			expect(fakeThis.session.retainGitCheckpointWithoutVerification).not.toHaveBeenCalled();
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("已恢复任务更改"));
		});

		test("warns that restore cannot prove opaque external side effects were reverted", async () => {
			initTheme("dark");
			const checkpoint = restoreCheckpoint("checkpoint-opaque-restore");
			const fakeThis = createRestoreDecisionContext("恢复任务更改", checkpoint);
			checkpointMocks.restoreGitCheckpoint.mockResolvedValue({ ok: true, externalSideEffectsUnknown: true });

			await (InteractiveMode as any).prototype.maybeOfferGitVersionSave.call(fakeThis, checkpoint);

			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("无法静态验证外部副作用"));
		});

		test("keeping the changes closes the checkpoint", async () => {
			initTheme("dark");
			const checkpoint = restoreCheckpoint("checkpoint-keep");
			const fakeThis = createRestoreDecisionContext("保留未提交的更改", checkpoint);

			await (InteractiveMode as any).prototype.maybeOfferGitVersionSave.call(fakeThis, checkpoint);

			expect(checkpointMocks.restoreGitCheckpoint).not.toHaveBeenCalled();
			expect(fakeThis.session.retainGitCheckpointWithoutVerification).toHaveBeenCalledWith(checkpoint);
			expect(checkpoint.status).toBe("retained");
		});

		test("cancelling leaves the checkpoint open and the session idle", async () => {
			initTheme("dark");
			const checkpoint = restoreCheckpoint("checkpoint-cancel");
			const fakeThis = createRestoreDecisionContext(undefined, checkpoint);

			await (InteractiveMode as any).prototype.maybeOfferGitVersionSave.call(fakeThis, checkpoint);

			expect(checkpoint.status).toBe("created");
			expect(fakeThis.taskDecisionActive).toBe(false);
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("未完成任务决策"));
		});

		test("a failed restore marks the checkpoint invalid so the session is not held", async () => {
			initTheme("dark");
			const checkpoint = restoreCheckpoint("checkpoint-restore-failed");
			const fakeThis = createRestoreDecisionContext("恢复任务更改", checkpoint);
			checkpointMocks.restoreGitCheckpoint.mockResolvedValue({ ok: false, error: "restore failed" });

			await (InteractiveMode as any).prototype.maybeOfferGitVersionSave.call(fakeThis, checkpoint);

			expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("restore failed"));
			expect(checkpoint.status).toBe("invalid");
			expect(fakeThis.taskDecisionActive).toBe(false);
		});
	});

	test("publishes the buffered response when the Final ChangeSet has no changes", async () => {
		const calls: string[] = [];
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
				getGitIntegrationSettings: () => ({ enabled: false }),
			},
			ensureWorkspaceBaseline: async () => undefined,
			workspaceBaselineFailureReason: undefined,
			session: {
				getGitCheckpoint: () => undefined,
				completeGitCheckpointAfterVerification: () => ({ ok: true }),
				extensionRunner: { emit: async () => {} },
			},
			publishBufferedAssistantMessage: () => calls.push("publish"),
			showError: vi.fn(),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		fakeThis.settleFailedTaskGitCheckpoint = vi.fn(async () => {});

		completionGateMocks.collectFinalWorkspaceChanges.mockResolvedValue({ status: "known", changes: [] });

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(completionGateMocks.collectFinalWorkspaceChanges).toHaveBeenCalled();
		expect(calls).toEqual(["publish"]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("warns when detection is indeterminate and still publishes the response", async () => {
		const fakeThis: any = {
			completionWorkflowActive: false,
			pendingResponseReadyMessages: [{ role: "assistant" }],
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutoMemorySettings: () => ({ enabled: false }),
				getGitIntegrationSettings: () => ({ enabled: false }),
			},
			ensureWorkspaceBaseline: async () => undefined,
			workspaceBaselineFailureReason: undefined,
			session: {
				getGitCheckpoint: () => undefined,
				completeGitCheckpointAfterVerification: () => ({ ok: true }),
				extensionRunner: { emit: async () => {} },
			},
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			publishBufferedAssistantMessage: vi.fn(),
		};
		fakeThis.emitAgentResponseReady = () => (InteractiveMode as any).prototype.emitAgentResponseReady.call(fakeThis);
		fakeThis.settleFailedTaskGitCheckpoint = vi.fn(async () => {});

		completionGateMocks.collectFinalWorkspaceChanges.mockResolvedValue({
			status: "indeterminate",
			changes: [],
			reason: "工作区超过基线快照上限",
		});

		(InteractiveMode as any).prototype.maybeStartCompletionWorkflow.call(fakeThis);
		await fakeThis.completionWorkflowPromise;

		expect(fakeThis.showWarning).toHaveBeenCalled();
		expect(fakeThis.publishBufferedAssistantMessage).toHaveBeenCalledOnce();
	});

	describe("本地提交更改自动修复", () => {
		const commitCheckpoint = { ...makeCreatedCheckpoint("checkpoint-commit"), repositoryRoot: process.cwd() };

		function createCommitThis(): any {
			const fakeThis: any = {
				session: {
					completeGitCheckpointAfterVerification: vi.fn(() => ({ ok: true })),
					sendCustomMessage: vi.fn(async () => {}),
				},
				clearPendingStartupGitCheckpoint: vi.fn(),
				showStatus: vi.fn(),
				showWarning: vi.fn(),
				showError: vi.fn(),
				showGitFailure: vi.fn(),
				updateGitCommitTask: vi.fn(),
				clearGitCommitTask: vi.fn(),
				finishGitCommitTaskAsFailed: vi.fn(),
				// Popup reminders disabled: these tests cover the commit workflow,
				// not the desktop notification side effect.
				shutdownRequested: false,
				settingsManager: {
					getPopupNotificationSettings: () => ({
						enabled: false,
						style: "toast",
						onCompleted: true,
						onError: true,
						onInterrupted: true,
					}),
				},
				sessionManager: { getCwd: () => "/workspace/current" },
			};
			fakeThis.formatGitFailure = (InteractiveMode as any).prototype.formatGitFailure;
			fakeThis.finishGitCommitDecision = (InteractiveMode as any).prototype.finishGitCommitDecision;
			fakeThis.finishGitCommitTask = (InteractiveMode as any).prototype.finishGitCommitTask;
			fakeThis.planGitCommitRepair = (InteractiveMode as any).prototype.planGitCommitRepair;
			fakeThis.classifyGitCommitFailure = (InteractiveMode as any).prototype.classifyGitCommitFailure;
			fakeThis.readGitCommitTargetPendingPaths = (InteractiveMode as any).prototype.readGitCommitTargetPendingPaths;
			fakeThis.submitGitCommitWithRepair = (InteractiveMode as any).prototype.submitGitCommitWithRepair;
			fakeThis.handleGitCommitFailure = (InteractiveMode as any).prototype.handleGitCommitFailure;
			fakeThis.requestAgentGitCommitRepair = (InteractiveMode as any).prototype.requestAgentGitCommitRepair;
			fakeThis.showOperationPopup = (InteractiveMode as any).prototype.showOperationPopup;
			fakeThis.popupTitle = (InteractiveMode as any).prototype.popupTitle;
			return fakeThis;
		}

		test("direct /commit target reuses the same workflow without a checkpoint or push", async () => {
			gitCommitMocks.createGitCommitForPathsAsync.mockResolvedValue({
				ok: true,
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
			const fakeThis = createCommitThis();
			const target = { repositoryRoot: "/workspace/current" };

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, target);

			expect(gitCommitMocks.createGitCommitForPathsAsync).toHaveBeenCalledWith(
				"/workspace/current",
				["src/a.ts"],
				"fix: 修复测试问题\n\n- M src/a.ts",
			);
			expect(fakeThis.session.completeGitCheckpointAfterVerification).not.toHaveBeenCalled();
			expect(fakeThis.session.sendCustomMessage).not.toHaveBeenCalled();
		});

		test("direct /commit with no working tree changes exits cleanly", async () => {
			checkpointMocks.getGitWorkingTreePathsAsync.mockResolvedValue({ paths: [] });
			const fakeThis = createCommitThis();

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, {
				repositoryRoot: "/workspace/current",
			});

			expect(fakeThis.showStatus).toHaveBeenCalledWith("没有需要提交的本地改动");
			expect(fakeThis.showWarning).not.toHaveBeenCalled();
			expect(gitCommitMocks.createGitCommitForPathsAsync).not.toHaveBeenCalled();
		});

		test("成功时完成 checkpoint 并显示提交信息标题", async () => {
			gitCommitMocks.createGitCommitForPathsAsync.mockResolvedValue({
				ok: true,
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
			const fakeThis = createCommitThis();

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, commitCheckpoint);

			expect(fakeThis.session.completeGitCheckpointAfterVerification).toHaveBeenCalledOnce();
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("已本地提交任务修改（1 个路径）"));
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("fix: 修复测试问题"));
			expect(fakeThis.showError).not.toHaveBeenCalled();
			expect(fakeThis.session.sendCustomMessage).not.toHaveBeenCalled();
		});

		test("超时失败后自动修复并用更长超时重试成功", async () => {
			gitCommitMocks.createGitCommitForPathsAsync
				.mockResolvedValueOnce({
					ok: false,
					stdout: "",
					stderr: "",
					exitCode: null,
					failureKind: "timeout",
					error: "git commit -m ... timed out after 15000ms",
				})
				.mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 });
			const fakeThis = createCommitThis();

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, commitCheckpoint);

			expect(gitCommitMocks.createGitCommitForPathsAsync).toHaveBeenCalledTimes(2);
			expect(gitCommitMocks.createGitCommitForPathsAsync).toHaveBeenLastCalledWith(
				commitCheckpoint.repositoryRoot,
				["src/a.ts"],
				"fix: 修复测试问题\n\n- M src/a.ts",
				300_000,
			);
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("已本地提交任务修改"));
			expect(fakeThis.session.completeGitCheckpointAfterVerification).toHaveBeenCalledOnce();
		});

		test("index.lock 残留时保留锁文件并停止自动重试", async () => {
			gitCommitMocks.createGitCommitForPathsAsync
				.mockResolvedValueOnce({
					ok: false,
					stdout: "",
					stderr: "fatal: Unable to create '.git/index.lock'",
					exitCode: 128,
				})
				.mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 });
			const fakeThis = createCommitThis();
			// 在真实临时目录中放置 index.lock，验证自动修复不会删除未知归属的锁。
			const lockDir = mkdtempSync(path.join(tmpdir(), "myharness-git-lock-"));
			try {
				const gitDir = path.join(lockDir, ".git");
				mkdirSync(gitDir, { recursive: true });
				const lockPath = path.join(gitDir, "index.lock");
				writeFileSync(lockPath, "locked");
				const lockCheckpoint = { ...commitCheckpoint, repositoryRoot: lockDir };

				await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, lockCheckpoint);

				expect(existsSync(lockPath)).toBe(true);
				expect(gitCommitMocks.createGitCommitForPathsAsync).toHaveBeenCalledTimes(1);
				expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledWith(
					expect.objectContaining({ stderr: "fatal: Unable to create '.git/index.lock'" }),
					"该问题无法安全自动修复",
				);
			} finally {
				rmSync(lockDir, { recursive: true, force: true });
			}
		});

		test("无实际变更时按成功处理并完成 checkpoint", async () => {
			checkpointMocks.getGitCheckpointPendingTaskPathsAsync
				.mockResolvedValueOnce({ paths: ["src/a.ts"] })
				.mockResolvedValueOnce({ paths: [] });
			gitCommitMocks.createGitCommitForPathsAsync.mockResolvedValue({
				ok: false,
				stdout: "",
				stderr: "nothing to commit",
				exitCode: 1,
			});
			const fakeThis = createCommitThis();

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, commitCheckpoint);

			expect(fakeThis.session.completeGitCheckpointAfterVerification).toHaveBeenCalledOnce();
			expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("无需重复提交"));
			expect(fakeThis.showError).not.toHaveBeenCalled();
		});

		test.each([{ paths: ["src/a.ts"] }, { error: "git status failed" }])(
			"Git 输出 no changes 但状态仍有改动或读取失败时不得按无变更完成 (%j)",
			async (currentStatus) => {
				checkpointMocks.getGitCheckpointPendingTaskPathsAsync
					.mockResolvedValueOnce({ paths: ["src/a.ts"] })
					.mockResolvedValueOnce(currentStatus);
				gitCommitMocks.createGitCommitForPathsAsync.mockResolvedValue({
					ok: false,
					stdout: "",
					stderr: "nothing to commit",
					exitCode: 1,
				});
				const fakeThis = createCommitThis();

				await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, commitCheckpoint);

				expect(checkpointMocks.getGitCheckpointPendingTaskPathsAsync).toHaveBeenCalledTimes(2);
				expect(fakeThis.session.completeGitCheckpointAfterVerification).not.toHaveBeenCalled();
				expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledWith(
					expect.objectContaining({ stderr: "nothing to commit" }),
					"自动修复未能解决提交问题",
				);
			},
		);

		test("代码质量失败时请求 Agent 修复且不完成 checkpoint", async () => {
			gitCommitMocks.createGitCommitForPathsAsync.mockResolvedValue({
				ok: false,
				stdout: "",
				stderr: "pre-commit hook failed",
				exitCode: 1,
			});
			const fakeThis = createCommitThis();

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, commitCheckpoint);

			expect(fakeThis.session.sendCustomMessage).toHaveBeenCalledOnce();
			expect(fakeThis.session.sendCustomMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "git-commit-failure" }),
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			expect(fakeThis.session.completeGitCheckpointAfterVerification).not.toHaveBeenCalled();
			expect(fakeThis.gitCommitAgentRetry).toBeDefined();
		});

		test("不可恢复失败时进入最终失败并给出准确摘要", async () => {
			const failure = {
				ok: false,
				stdout: "",
				stderr: "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host: example.com",
				exitCode: 128,
			};
			gitCommitMocks.createGitCommitForPathsAsync.mockResolvedValue(failure);
			const fakeThis = createCommitThis();

			await (InteractiveMode as any).prototype.runGitCommitTask.call(fakeThis, commitCheckpoint);

			expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledOnce();
			expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledWith(failure, "该问题无法安全自动修复");
			expect(fakeThis.session.sendCustomMessage).not.toHaveBeenCalled();
			expect(fakeThis.session.completeGitCheckpointAfterVerification).not.toHaveBeenCalled();
		});

		test("相同错误连续重复时不重复请求 Agent 修复（防无限循环）", async () => {
			const failure = {
				ok: false,
				stdout: "",
				stderr: "pre-commit hook failed",
				exitCode: 1,
			};
			const fakeThis = createCommitThis();
			fakeThis.gitCommitAgentRetry = {
				checkpoint: commitCheckpoint,
				agentRepairCount: 1,
				// 与 failure 相同的签名：Agent 修复后错误没有变化，不再重复修复。
				lastFailureSignature: [1, undefined, "pre-commit hook failed", ""].join("\u0000"),
			};

			await (InteractiveMode as any).prototype.handleGitCommitFailure.call(fakeThis, commitCheckpoint, failure);

			expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledOnce();
			expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledWith(failure, "Agent 修复未能解决提交问题");
			expect(fakeThis.session.sendCustomMessage).not.toHaveBeenCalled();
		});

		test("Agent 修复轮数达到上限后不再修复", async () => {
			const failure = {
				ok: false,
				stdout: "",
				stderr: "pre-commit hook failed",
				exitCode: 1,
			};
			const fakeThis = createCommitThis();
			fakeThis.gitCommitAgentRetry = {
				checkpoint: commitCheckpoint,
				agentRepairCount: 2,
				lastFailureSignature: "different-signature",
			};

			await (InteractiveMode as any).prototype.handleGitCommitFailure.call(fakeThis, commitCheckpoint, failure);

			expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledOnce();
			expect(fakeThis.finishGitCommitTaskAsFailed).toHaveBeenCalledWith(failure, "Agent 修复未能解决提交问题");
			expect(fakeThis.session.sendCustomMessage).not.toHaveBeenCalled();
		});
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	test("merges triggerCharacters from wrapper factories", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				triggerCharacters,
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		(
			InteractiveMode as unknown as {
				prototype: { setupAutocompleteProvider: (this: typeof fakeThis) => void };
			}
		).prototype.setupAutocompleteProvider.call(fakeThis);

		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("matches model command arguments across provider/model order", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRuntime: { getAvailable: () => TestModel[] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: {
				getEnableSkillCommands: () => boolean;
				getSlashCommandUsageCounts: () => Record<string, number>;
			};
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const models = [
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			{ id: "gpt-5.3-codex", provider: "openai", name: "GPT-5.3 Codex" },
		];
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailable: () => models },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false, getSlashCommandUsageCounts: () => ({}) },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const line = "/model codexgpt";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"openai/gpt-5.3-codex",
			"github-copilot/gpt-5.2-codex",
		]);
	});

	test("orders top-level slash commands by persisted usage", async () => {
		const fakeThis: any = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailable: () => [] },
				promptTemplates: [],
				extensionRunner: {
					getRegisteredCommands: () => [
						{
							name: "mode",
							invocationName: "mode",
							description: "查看或设置当前模式",
						},
					],
				},
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: {
				getEnableSkillCommands: () => false,
				getSlashCommandUsageCounts: () => ({ mode: 5, compact: 3, workflows: 20, reload: 10 }),
			},
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
			prefixAutocompleteDescription: (description?: string) => description,
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: typeof fakeThis): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const suggestions = await provider.getSuggestions(["/"], 0, 1, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"mode",
			"compact",
			"settings",
			"model",
			"new",
			"workspace",
			"git",
			"effort",
			"commit",
			"push",
			"restore",
			"undo",
			"workflow",
			"ultracode",
		]);
	});
});
describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.myharness/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.myharness/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.myharness/extensions",
				}),
			},
			{
				path: "/tmp/project/.myharness/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.myharness/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.myharness/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.myharness/npm/node_modules/myharness-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.myharness/npm/node_modules/myharness-markdown-preview/extensions/index.ts",
					{
						source: "npm:myharness-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.myharness/npm/node_modules/myharness-markdown-preview",
					},
				),
			},
			{
				path: "/tmp/project/.myharness/npm/node_modules/@scope/myharness-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.myharness/npm/node_modules/@scope/myharness-scoped/extensions/index.ts",
					{
						source: "npm:@scope/myharness-scoped",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.myharness/npm/node_modules/@scope/myharness-scoped",
					},
				),
			},
			{
				path: "/tmp/project/.myharness/git/github.com/HazAT/myharness-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.myharness/git/github.com/HazAT/myharness-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/myharness-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.myharness/git/github.com/HazAT/myharness-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.myharness/git/github.com/HazAT/myharness-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.myharness/git/github.com/HazAT/myharness-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/myharness-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.myharness/git/github.com/HazAT/myharness-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("shows a compact resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/myharness-scoped, answer.ts, cli-extension.ts, HazAT/myharness-interactive-subagents, HazAT/myharness-interactive-subagents:subagents, local-index, myharness-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.myharness/npm/node_modules/myharness-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.myharness/npm/node_modules/myharness-markdown-preview/extensions/index.ts",
					{
						source: "npm:myharness-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.myharness/npm/node_modules/myharness-markdown-preview",
					},
				),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  myharness-markdown-preview"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.myharness/extensions/answer.ts
    /tmp/project/.myharness/extensions/local-index
    git:github.com/HazAT/myharness-interactive-subagents
      extensions
      extensions/subagents
    npm:@scope/myharness-scoped
      extensions
    npm:myharness-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "MyHarness");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".myharness", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.myharness/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "MyHarness");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".myharness", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.myharness/agent/AGENTS.md");
		expect(output).toContain("~/Development/MyHarness/AGENTS.md");
		expect(output).not.toContain("~/.myharness/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
