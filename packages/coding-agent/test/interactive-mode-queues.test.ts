import { describe, expect, it, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CompactionQueuedMessage = { text: string; mode: "steer" | "followUp" };

type QueueContext = {
	pendingUserInputs: string[];
	compactionQueuedMessages: CompactionQueuedMessage[];
	session: { clearQueue: () => { steering: string[]; followUp: string[] } };
	editor: { getText: () => string; setText: (text: string) => void };
	updatePendingMessagesDisplay: () => void;
	agent: { abort: () => void };
	ui: { requestRender: () => void };
	clearAllQueues: () => { steering: string[]; followUp: string[]; pending: string[] };
};

type RenderStateContext = {
	loadedResourcesContainer: Container;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	clearTransientStatus: () => void;
	compactionQueuedMessages: CompactionQueuedMessage[];
	pendingUserInputs: string[];
	streamingComponent: unknown;
	streamingMessage: unknown;
	pendingTools: Map<string, unknown>;
	activeToolNames: Map<string, string>;
	lastTerminalRunState: unknown;
	taskStatusBar: { clear: () => void };
	renderInitialMessages: () => void;
};

type EscapeContext = {
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		abortCompaction: () => void;
		abortBash: () => void;
	};
	editor: { getText: () => string; setText: (text: string) => void };
	defaultEditor: { onEscape?: () => void; onAction?: (action: string, handler: () => void) => void };
	isBashMode: boolean;
	lastEscapeTime: number;
	updateEditorBorderColor: () => void;
	restoreQueuedMessagesToEditor: (options?: { abort?: boolean }) => number;
};

type InteractiveModePrivate = {
	clearAllQueues(this: QueueContext): { steering: string[]; followUp: string[]; pending: string[] };
	restoreQueuedMessagesToEditor(this: QueueContext, options?: { abort?: boolean; currentText?: string }): number;
	renderCurrentSessionState(this: RenderStateContext): void;
	setupKeyHandlers(this: EscapeContext): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createQueueContext(): QueueContext {
	return {
		pendingUserInputs: ["pending one"],
		compactionQueuedMessages: [{ text: "compaction steer", mode: "steer" }],
		session: { clearQueue: () => ({ steering: ["steer"], followUp: ["follow"] }) },
		editor: { getText: () => "draft", setText: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		agent: { abort: vi.fn() },
		ui: { requestRender: vi.fn() },
		// restoreQueuedMessagesToEditor delegates to this method.
		clearAllQueues: prototype.clearAllQueues,
	};
}

describe("InteractiveMode queued-message handling", () => {
	it("clears and returns the pending queue together with session and compaction queues", () => {
		const context = createQueueContext();

		const result = prototype.clearAllQueues.call(context);

		expect(result).toEqual({
			steering: ["steer", "compaction steer"],
			followUp: ["follow"],
			pending: ["pending one"],
		});
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.compactionQueuedMessages).toEqual([]);
	});

	it("restores pending messages to the editor on dequeue", () => {
		const context = createQueueContext();

		const restored = prototype.restoreQueuedMessagesToEditor.call(context);

		expect(restored).toBe(4);
		expect(context.editor.setText).toHaveBeenCalledWith(
			"steer\n\ncompaction steer\n\nfollow\n\npending one\n\ndraft",
		);
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("clears queued input when the session is rebound", () => {
		const context: RenderStateContext = {
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			clearTransientStatus: vi.fn(),
			compactionQueuedMessages: [{ text: "queued for old session", mode: "steer" }],
			pendingUserInputs: ["queued for old task"],
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			activeToolNames: new Map(),
			lastTerminalRunState: undefined,
			taskStatusBar: { clear: vi.fn() },
			renderInitialMessages: vi.fn(),
		};

		prototype.renderCurrentSessionState.call(context);

		expect(context.pendingUserInputs).toEqual([]);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.taskStatusBar.clear).toHaveBeenCalledTimes(1);
		expect(context.renderInitialMessages).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode escape cancel entry", () => {
	function createEscapeContext(isCompacting: boolean, isStreaming: boolean): EscapeContext {
		return {
			session: {
				isCompacting,
				isStreaming,
				isBashRunning: false,
				abortCompaction: vi.fn(),
				abortBash: vi.fn(),
			},
			editor: { getText: () => "", setText: vi.fn() },
			defaultEditor: { onAction: vi.fn() },
			isBashMode: false,
			lastEscapeTime: 0,
			updateEditorBorderColor: vi.fn(),
			restoreQueuedMessagesToEditor: vi.fn(() => 0),
		};
	}

	it("cancels compaction from the setup window before compaction_start installs its handler", () => {
		const context = createEscapeContext(true, true); // overflow compaction while streaming
		prototype.setupKeyHandlers.call(context);

		context.defaultEditor.onEscape?.();

		expect(context.session.abortCompaction).toHaveBeenCalledTimes(1);
		expect(context.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
	});

	it("keeps aborting a streaming run when no compaction is active", () => {
		const context = createEscapeContext(false, true);
		prototype.setupKeyHandlers.call(context);

		context.defaultEditor.onEscape?.();

		expect(context.restoreQueuedMessagesToEditor).toHaveBeenCalledWith({ abort: true });
		expect(context.session.abortCompaction).not.toHaveBeenCalled();
	});
});
