import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
		reload?: () => Promise<void>;
		resourceLoader?: { getThemes: () => { themes: unknown[] } };
		extensionRunner?: { getShortcuts: () => Map<unknown, unknown> };
		lastReloadError?: string;
	};
	flushPendingBashComponents: () => void;
	recordSlashCommandUsage: (text: string) => void;
	completionWorkflowActive: boolean;
	completionWorkflowPromise?: Promise<void>;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	showStatus: (text: string) => void;
	showWarning?: (text: string) => void;
	clearStatusIndicator?: () => void;
	setupAutocompleteProvider?: () => void;
	footer?: { invalidate: () => void };
	updateEditorBorderColor?: () => void;
	reloadResources?: () => Promise<void>;
	handleCommitCommand?: () => Promise<void>;
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
	isReloading?: boolean;
	queueCompactionMessage?: (text: string, mode: "steer" | "followUp", statusText?: string) => void;
	isExtensionCommand?: (text: string) => boolean;
	showStatusIndicator?: (indicator: unknown) => void;
	addMessageToChat?: (message: unknown) => void;
	buildReloadResourcesText?: () => string;
	flushCompactionQueue?: (options?: { willRetry?: boolean }) => Promise<void>;
	showError?: (text: string) => void;
	resetExtensionUI?: () => void;
	applyRuntimeSettings?: () => void;
	themeController?: { applyFromSettings: () => Promise<void> };
	setupExtensionShortcuts?: () => void;
	showLoadedResources?: () => void;
	updateAvailableProviderCount?: () => Promise<void>;
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		recordSlashCommandUsage: vi.fn(),
		completionWorkflowActive: false,
		pendingUserInputs: [],
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		clearStatusIndicator: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		reloadResources: vi.fn(async () => {}),
		handleCommitCommand: vi.fn(async () => {}),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		isReloading: false,
		queueCompactionMessage: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		showStatusIndicator: vi.fn(),
		addMessageToChat: vi.fn(),
		buildReloadResourcesText: vi.fn(() => ""),
		flushCompactionQueue: vi.fn(async () => {}),
		showError: vi.fn(),
		resetExtensionUI: vi.fn(),
		applyRuntimeSettings: vi.fn(),
		themeController: { applyFromSettings: vi.fn(async () => {}) },
		setupExtensionShortcuts: vi.fn(),
		showLoadedResources: vi.fn(),
		updateAvailableProviderCount: vi.fn(async () => {}),
	};
}

describe("InteractiveMode startup input", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("shows a queued prompt while the completion workflow is still finishing", async () => {
		const context = createSubmitContext();
		context.completionWorkflowActive = true;
		context.onInputCallback = vi.fn();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("next question");

		expect(context.pendingUserInputs).toEqual(["next question"]);
		expect(context.onInputCallback).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("消息已排队；任务完成后发送（1 条）");
	});

	it("runs the local commit workflow only for /commit", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/commit");

		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.handleCommitCommand).toHaveBeenCalledTimes(1);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.onInputCallback).toBeUndefined();
	});

	it("passes ordinary input through without starting the local commit workflow", async () => {
		const context = createSubmitContext();
		context.onInputCallback = vi.fn();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("finish the task");

		expect(context.handleCommitCommand).not.toHaveBeenCalled();
		expect(context.onInputCallback).toHaveBeenCalledWith("finish the task");
	});

	it.each(["/reload", "/reload extra", "/workflows", "/workflows extra"])(
		"passes removed command %s through as ordinary input",
		async (text) => {
			const context = createSubmitContext();
			context.onInputCallback = vi.fn();
			interactiveModePrototype.setupEditorSubmitHandler.call(context);

			await context.defaultEditor.onSubmit?.(text);

			expect(context.onInputCallback).toHaveBeenCalledWith(text);
			expect(context.reloadResources).not.toHaveBeenCalled();
			expect(context.showWarning).not.toHaveBeenCalled();
		},
	);

	it("queues normal messages while reload is in progress", async () => {
		const context = createSubmitContext();
		context.isReloading = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("hello while reloading");

		expect(context.queueCompactionMessage).toHaveBeenCalledWith(
			"hello while reloading",
			"steer",
			"Queued message for after reload",
		);
		expect(context.onInputCallback).toBeUndefined();
	});

	it("refuses to reload configuration while the session is busy", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		context.session.reload = vi.fn(async () => {});

		const runtime = InteractiveMode.prototype as unknown as {
			reloadResources(this: SubmitContext): Promise<void>;
		};
		await runtime.reloadResources.call(context);

		expect(context.session.reload).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith(expect.stringContaining("当前会话正忙"));
	});

	it("reloads session resources and refreshes UI", async () => {
		const context = createSubmitContext();
		context.session.reload = vi.fn(async () => {});
		context.session.resourceLoader = { getThemes: () => ({ themes: [] }) };
		context.session.extensionRunner = { getShortcuts: () => new Map() };

		const runtime = InteractiveMode.prototype as unknown as {
			reloadResources(this: SubmitContext): Promise<void>;
		};
		await runtime.reloadResources.call(context);

		expect(context.session.reload).toHaveBeenCalledTimes(1);
		expect(context.resetExtensionUI).toHaveBeenCalledTimes(1);
		expect(context.applyRuntimeSettings).toHaveBeenCalledTimes(1);
		expect(context.themeController?.applyFromSettings).toHaveBeenCalledTimes(1);
		expect(context.setupExtensionShortcuts).toHaveBeenCalledTimes(1);
		expect(context.showLoadedResources).toHaveBeenCalledTimes(1);
		expect(context.updateAvailableProviderCount).toHaveBeenCalledTimes(1);
		expect(context.showStatusIndicator).toHaveBeenCalledTimes(1);
		expect(context.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({ role: "reloadSummary", ok: true }),
		);
		expect(context.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("已经加载最新配置"));
	});

	it("records a failed reload in the chat", async () => {
		const context = createSubmitContext();
		context.session.reload = vi.fn(async () => {
			throw new Error("boom");
		});

		const runtime = InteractiveMode.prototype as unknown as {
			reloadResources(this: SubmitContext): Promise<void>;
		};
		await runtime.reloadResources.call(context);

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("重新加载配置失败：boom"));
		expect(context.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({ role: "reloadSummary", ok: false, error: "boom" }),
		);
		expect(context.isReloading).toBe(false);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});
});
