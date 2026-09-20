import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds the persisted branch without appending a duplicate compaction summary", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("reports measured context without a target warning", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn(), addChild: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result:
					| {
							tokensBefore: number;
							summary: string;
							targetReached: boolean;
							estimatedTokensAfter: number;
							diagnostics: { effectiveWindow: number };
					  }
					| undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				targetReached: false,
				estimatedTokensAfter: 50_000,
				diagnostics: { effectiveWindow: 250_000 },
			},
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction target 10.0% not reached: final 50000 vs target 25000.",
		});

		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Compact 完成：上下文约 50000 tokens");
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			promptUserInput: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.promptUserInput).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode UI history vs compacted agent context", () => {
	test("renderInitialMessages renders the full persisted branch, not the compacted projection", () => {
		const fullBranch = [{ id: "a" }, { id: "b" }];
		const compacted = [{ id: "c" }];
		const fakeThis = {
			sessionManager: {
				getBranch: vi.fn(() => fullBranch),
				buildContextEntries: vi.fn(() => compacted),
				getEntries: vi.fn(() => [{ type: "compaction" }]),
			},
			renderSessionEntries: vi.fn(),
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
		};

		const renderInitialMessages = Reflect.get(InteractiveMode.prototype, "renderInitialMessages") as (
			this: typeof fakeThis,
		) => void;

		renderInitialMessages.call(fakeThis);

		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(fullBranch, {
			updateFooter: true,
			populateHistory: true,
		});
		expect(fakeThis.sessionManager.buildContextEntries).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalled();
	});

	test("rebuildChatFromMessages renders the full persisted branch", () => {
		const fullBranch = [{ id: "a" }, { id: "b" }];
		const fakeThis = {
			sessionManager: {
				getBranch: vi.fn(() => fullBranch),
				buildContextEntries: vi.fn(),
			},
			chatContainer: { clear: vi.fn() },
			renderSessionEntries: vi.fn(),
		};

		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
		) => void;

		rebuildChatFromMessages.call(fakeThis);

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(fullBranch);
		expect(fakeThis.sessionManager.buildContextEntries).not.toHaveBeenCalled();
	});
});
