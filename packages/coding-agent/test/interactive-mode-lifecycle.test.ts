import { describe, expect, test, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import type { RunState, RunStateSnapshot } from "../src/agent/runtime/run-state.ts";
import { IdleStatus } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * InteractiveMode task-lifecycle regression tests.
 *
 * The outer task boundary is agent_settled, NOT agent_end or compaction_end:
 * compaction, retry, continue and queued messages all keep the task busy and
 * the Windows terminal progress ON until the outer run truly settles.
 */

function createLifecycleContext(initialRunState: RunState) {
	const snapshot: RunStateSnapshot = { state: initialRunState, activity: "", lastActivityAt: Date.now() };
	const prototype = InteractiveMode.prototype as any;
	const originalEscape = () => {};
	const context: any = {
		shutdownRequested: false,
		isInitialized: true,
		session: {
			isStreaming: initialRunState !== "idle",
			getRunStateSnapshot: () => snapshot,
			getGitCheckpoint: () => undefined,
			abortCompaction: vi.fn(),
			abortRetry: vi.fn(),
			bashExecutionCount: 0,
		},
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
		pendingTools: new Map(),
		activeToolNames: new Set(),
		pendingResponseReadyMessages: [] as unknown[],
		streamingComponent: undefined,
		streamingMessage: undefined,
		streamingComponentAttached: false,
		delayStreamingAssistant: false,
		bufferedAssistantMessage: undefined,
		completionVerificationStatus: "working",
		workspaceBaselinePromise: undefined,
		workspaceBaselineFailureReason: undefined,
		_bashCountAtRunStart: 0,
		_indeterminateChangeWarningShown: false,
		ensureWorkspaceBaseline: vi.fn(async () => undefined),
		retryEscapeHandler: undefined,
		autoCompactionEscapeHandler: undefined,
		pendingStartupGitCheckpoint: undefined,
		defaultEditor: { onEscape: originalEscape },
		chatContainer: new Container(),
		clearTransientStatus: vi.fn(),
		footer: { invalidate: vi.fn() },
		rebuildChatFromMessages: vi.fn(),
		addMessageToChat: vi.fn(),
		flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
		showError: vi.fn(),
		showStatus: vi.fn(),
		ui: {
			getClearOnShrink: () => false,
			requestRender: vi.fn(),
			terminal: { setProgress: vi.fn() },
		},
		settingsManager: {
			getShowTerminalProgress: () => true,
			// Popup reminders disabled in lifecycle tests so terminal outcomes never
			// spawn real desktop notifications.
			getPopupNotificationSettings: () => ({
				enabled: false,
				style: "toast" as const,
				onCompleted: true,
				onError: true,
				onInterrupted: true,
			}),
		},
		maybeStartCompletionWorkflow: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		settleFailedTaskGitCheckpoint: vi.fn(async () => {}),
	};

	context.getTaskLifecyclePhase = prototype.getTaskLifecyclePhase;
	context.hasPendingGitCheckpointDecision = prototype.hasPendingGitCheckpointDecision;
	context.getWorkingStatusIndicator = prototype.getWorkingStatusIndicator;
	context.renderStatusIndicators = prototype.renderStatusIndicators;
	context.showStatusIndicator = prototype.showStatusIndicator;
	context.clearStatusIndicator = prototype.clearStatusIndicator;
	context.syncTaskStatusBar = vi.fn();
	context.syncTaskLifecycleUI = prototype.syncTaskLifecycleUI;
	context.maybeShowPopupNotification = prototype.maybeShowPopupNotification;

	const handleEvent = prototype.handleEvent.bind(context) as (event: any) => Promise<void>;
	return { context, snapshot, handleEvent, originalEscape };
}

const successfulAgentEnd = {
	type: "agent_end",
	willRetry: false,
	messages: [{ role: "assistant", stopReason: "stop", content: [] }],
};

function setRunState(handleEvent: (event: any) => Promise<void>, snapshot: RunStateSnapshot, state: RunState) {
	snapshot.state = state;
	return handleEvent({ type: "run_state_changed", state: snapshot });
}

describe("InteractiveMode task lifecycle across agent events", () => {
	test("keeps busy and progress ON through compaction and continue until agent_settled", async () => {
		initTheme("dark");
		const { context, snapshot, handleEvent } = createLifecycleContext("idle");

		// agent_start → running
		await setRunState(handleEvent, snapshot, "running");
		await handleEvent({ type: "agent_start" });
		expect(context.statusIndicators.has("working")).toBe(true);
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		// agent_end → waiting (post-run housekeeping still active)
		await setRunState(handleEvent, snapshot, "waiting");
		await handleEvent(successfulAgentEnd);
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		// compaction_start → recovering
		await setRunState(handleEvent, snapshot, "recovering");
		await handleEvent({ type: "compaction_start", reason: "threshold" });
		expect(context.statusIndicators.has("compaction")).toBe(true);
		expect(context.statusIndicators.has("working")).toBe(false);
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		// compaction_end (no retry, agent continues) → working restored
		await handleEvent({
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "summary", tokensBefore: 10 },
			aborted: false,
			willRetry: false,
		});
		expect(context.statusIndicators.has("compaction")).toBe(false);
		expect(context.statusIndicators.has("working")).toBe(true);
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		// continue → running
		await setRunState(handleEvent, snapshot, "running");
		await handleEvent({ type: "agent_start" });

		// agent_end again (outer run still not settled)
		await setRunState(handleEvent, snapshot, "waiting");
		await handleEvent(successfulAgentEnd);
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		// The task must never appear idle before the final agent_settled.
		const falseCalls = context.ui.terminal.setProgress.mock.calls.filter((call: [boolean]) => call[0] === false);
		expect(falseCalls).toHaveLength(0);

		// Terminal state then the settled boundary closes the task.
		await setRunState(handleEvent, snapshot, "completed");
		await setRunState(handleEvent, snapshot, "idle");
		await handleEvent({ type: "agent_settled" });

		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
		expect(context.statusIndicators.size).toBe(0);
	});

	test("normal end: busy until agent_settled, then idle with progress off", async () => {
		initTheme("dark");
		const { context, snapshot, handleEvent } = createLifecycleContext("idle");

		await setRunState(handleEvent, snapshot, "running");
		await handleEvent({ type: "agent_start" });
		await setRunState(handleEvent, snapshot, "waiting");
		await handleEvent(successfulAgentEnd);

		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);
		expect(context.statusIndicators.has("working")).toBe(true);

		await setRunState(handleEvent, snapshot, "completed");
		await setRunState(handleEvent, snapshot, "idle");
		await handleEvent({ type: "agent_settled" });

		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
		expect(context.statusIndicators.size).toBe(0);
	});

	test.each(["blocked", "interrupted"] as const)(
		"retains the %s terminal outcome for the settled UI projection",
		async (terminalState) => {
			initTheme("dark");
			const { context, snapshot, handleEvent } = createLifecycleContext("idle");
			snapshot.state = terminalState;

			await handleEvent({ type: "run_state_changed", state: snapshot });

			expect(context.lastTerminalRunState).toBe(snapshot);
			expect(context.completionWorkflowEligibleForRun).toBe(false);
		},
	);

	test("terminal failure skips completion and stays busy until agent_settled", async () => {
		initTheme("dark");
		const { context, snapshot, handleEvent } = createLifecycleContext("idle");

		await setRunState(handleEvent, snapshot, "running");
		await handleEvent({ type: "agent_start" });
		await setRunState(handleEvent, snapshot, "waiting");
		await handleEvent({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", stopReason: "error", content: [] }],
		});
		expect(context.maybeStartCompletionWorkflow).not.toHaveBeenCalled();
		expect(context.settleFailedTaskGitCheckpoint).not.toHaveBeenCalled();

		await setRunState(handleEvent, snapshot, "failed");
		await setRunState(handleEvent, snapshot, "idle");
		// AgentSession exposes idle before delivering agent_settled. The UI must
		// keep the task boundary active during that hand-off window.
		expect(context.getTaskLifecyclePhase()).toBe("main_agent");
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);

		await handleEvent({ type: "agent_settled" });
		expect(context.maybeStartCompletionWorkflow).not.toHaveBeenCalled();
		expect(context.settleFailedTaskGitCheckpoint).toHaveBeenCalledOnce();
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
	});

	test("abort during compaction restores the escape handler and never fakes idle", async () => {
		initTheme("dark");
		const { context, snapshot, handleEvent, originalEscape } = createLifecycleContext("recovering");

		await handleEvent({ type: "compaction_start", reason: "threshold" });
		expect(context.defaultEditor.onEscape).not.toBe(originalEscape);
		expect(context.statusIndicators.has("compaction")).toBe(true);

		await handleEvent({
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		expect(context.defaultEditor.onEscape).toBe(originalEscape);
		expect(context.statusIndicators.has("compaction")).toBe(false);
		// The outer run is still active: busy and progress stay ON.
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);
		expect(context.session.abortCompaction).not.toHaveBeenCalled();

		await setRunState(handleEvent, snapshot, "cancelled");
		await setRunState(handleEvent, snapshot, "idle");
		await handleEvent({ type: "agent_settled" });
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
	});

	test("compaction failure with an active outer run keeps the task busy, then settles cleanly", async () => {
		initTheme("dark");
		const { context, snapshot, handleEvent } = createLifecycleContext("recovering");

		await handleEvent({ type: "compaction_start", reason: "threshold" });
		await handleEvent({
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: provider unavailable",
		});
		// Failure is surfaced, but while the outer run is still active the UI
		// must not fall into a fake idle state.
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);
		expect(context.statusIndicators.has("working")).toBe(true);

		await setRunState(handleEvent, snapshot, "failed");
		await setRunState(handleEvent, snapshot, "idle");
		await handleEvent({ type: "agent_settled" });
		expect(context.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
		expect(context.statusIndicators.size).toBe(0);
	});

	test("reports a user-cancelled retry as cancelled instead of a failure", async () => {
		initTheme("dark");
		const { context, handleEvent } = createLifecycleContext("recovering");

		await handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "boom",
		});
		// User presses Esc to cancel the retry.
		context.defaultEditor.onEscape();
		expect(context.session.abortRetry).toHaveBeenCalledTimes(1);

		await handleEvent({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });

		expect(context.showError).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("已取消自动重试");
	});

	test("reports an exhausted retry as a failure", async () => {
		initTheme("dark");
		const { context, handleEvent } = createLifecycleContext("recovering");

		await handleEvent({
			type: "auto_retry_start",
			attempt: 3,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "520 status code (no body)",
		});
		await handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "520 status code (no body)",
		});

		expect(context.showError).toHaveBeenCalledTimes(1);
		const shown = context.showError.mock.calls[0][0] as string;
		expect(shown).toMatch(/^自动重试 3 次后仍然失败。模型请求失败：/);
		expect(shown).toContain("网关与后端服务器之间连接异常（HTTP 520）");
		expect(shown).toContain("没有返回任何错误说明");
		expect(context.showStatus).not.toHaveBeenCalledWith("已取消自动重试");
	});

	test("announces a fallback takeover and reports a failed fallback once", async () => {
		initTheme("dark");
		const { context, handleEvent, originalEscape } = createLifecycleContext("recovering");
		context.addSystemNote = vi.fn();
		context.pendingRecoverableErrorComponent = undefined;

		await handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "520 status code (no body)",
		});
		await handleEvent({
			type: "model_fallback_start",
			from: "main/model-a",
			to: "backup/model-b",
			retries: 3,
			reason: "模型请求失败：原因",
		});
		expect(context.defaultEditor.onEscape).toBe(originalEscape);
		expect(context.statusIndicators.has("retry")).toBe(false);
		expect(context.addSystemNote).toHaveBeenCalledWith(
			expect.stringContaining("已自动切换到备用模型 backup/model-b"),
		);

		await handleEvent({
			type: "model_fallback_end",
			success: false,
			from: "main/model-a",
			to: "backup/model-b",
			errorMessage: "模型请求失败：主模型和备用模型都失败了",
		});
		await handleEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "401 Unauthorized" });

		expect(context.showError).toHaveBeenCalledTimes(1);
		expect(context.showError).toHaveBeenCalledWith("模型请求失败：主模型和备用模型都失败了");
	});
});
