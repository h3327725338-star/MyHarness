import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState, RunStateSnapshot } from "../src/agent/runtime/run-state.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	buildPopupCommand,
	describeTerminalRunState,
	type PopupNotificationContent,
	popupKindForRunState,
	showPopupNotification,
} from "../src/utils/popup-notification.ts";

vi.mock("../src/utils/popup-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/popup-notification.ts")>();
	return { ...actual, showPopupNotification: vi.fn(() => true) };
});

const showPopupMock = vi.mocked(showPopupNotification);

function decodeWindowsScript(args: string[]): string {
	const encoded = args.at(-1);
	expect(encoded).toBeDefined();
	return Buffer.from(encoded as string, "base64").toString("utf16le");
}

const baseContent: PopupNotificationContent = {
	kind: "completed",
	title: "MyHarness · my-project",
	message: "任务完成\n用时 3 分 12 秒",
};

describe("popupKindForRunState", () => {
	it("maps terminal states to popup kinds", () => {
		expect(popupKindForRunState("completed")).toBe("completed");
		expect(popupKindForRunState("failed")).toBe("failed");
		expect(popupKindForRunState("timed_out")).toBe("failed");
		expect(popupKindForRunState("cancelled")).toBe("interrupted");
	});

	it("returns undefined for non-terminal states", () => {
		for (const state of ["idle", "queued", "starting", "running", "waiting", "recovering"] as RunState[]) {
			expect(popupKindForRunState(state)).toBeUndefined();
		}
	});
});

describe("describeTerminalRunState", () => {
	it("uses the activity text and appends a formatted duration", () => {
		const startedAt = 1_000_000;
		const message = describeTerminalRunState({
			state: "completed",
			activity: "任务完成",
			lastActivityAt: startedAt + 192_000,
			startedAt,
		});
		expect(message).toBe("任务完成\n用时 3 分 12 秒");
	});

	it("appends the error message and falls back to the state label", () => {
		const message = describeTerminalRunState({
			state: "failed",
			activity: "",
			error: "模型请求失败",
			lastActivityAt: Date.now(),
		});
		expect(message).toContain("失败");
		expect(message).toContain("模型请求失败");
	});

	it("does not duplicate the error when the activity already contains it", () => {
		const message = describeTerminalRunState({
			state: "failed",
			activity: "任务失败：请求失败",
			error: "请求失败",
			lastActivityAt: Date.now(),
		});
		expect(message).toBe("任务失败：请求失败");
	});

	it("omits the duration when the run has no meaningful start time", () => {
		const message = describeTerminalRunState({
			state: "cancelled",
			activity: "任务已取消",
			lastActivityAt: Date.now(),
		});
		expect(message).toBe("任务已取消");
	});
});

describe("buildPopupCommand", () => {
	it("builds an encoded toast command on Windows", () => {
		const popup = buildPopupCommand("win32", "toast", baseContent);
		expect(popup?.command).toBe("powershell.exe");
		const script = decodeWindowsScript(popup?.args ?? []);
		expect(script).toContain("ToastNotificationManager");
		expect(script).toContain("ToastGeneric");
		// Text is embedded as base64 UTF-8, never raw, so it survives code-page quirks.
		expect(script).toContain(Buffer.from(baseContent.title, "utf8").toString("base64"));
		expect(script).not.toContain("任务完成");
	});

	it("escapes XML-sensitive characters in toast text via SecurityElement", () => {
		const popup = buildPopupCommand("win32", "toast", {
			...baseContent,
			message: 'a<b>&"c"',
		});
		const script = decodeWindowsScript(popup?.args ?? []);
		expect(script).toContain("SecurityElement");
	});

	it("builds a topmost MessageBox command for the window style", () => {
		const popup = buildPopupCommand("win32", "window", { ...baseContent, kind: "failed" });
		const script = decodeWindowsScript(popup?.args ?? []);
		expect(script).toContain("System.Windows.Forms.MessageBox]::Show($form, $message, $title, 'OK', 'Error')");
		expect(script).toContain("$form.TopMost = $true");
	});

	it("uses the Warning icon for interrupted outcomes", () => {
		const popup = buildPopupCommand("win32", "window", { ...baseContent, kind: "interrupted" });
		const script = decodeWindowsScript(popup?.args ?? []);
		expect(script).toContain("'Warning'");
	});

	it("builds osascript commands on macOS", () => {
		const toast = buildPopupCommand("darwin", "toast", baseContent);
		expect(toast?.command).toBe("osascript");
		expect(toast?.args[0]).toBe("-e");
		expect(toast?.args[1]).toContain(
			'display notification "任务完成\\n用时 3 分 12 秒" with title "MyHarness · my-project"',
		);

		const dialog = buildPopupCommand("darwin", "window", baseContent);
		expect(dialog?.args[1]).toContain('display dialog "任务完成\\n用时 3 分 12 秒"');
		expect(dialog?.args[1]).toContain("giving up after 120");
	});

	it("escapes quotes and backslashes in AppleScript strings", () => {
		const popup = buildPopupCommand("darwin", "toast", {
			...baseContent,
			message: '他说 "hi" \\ done',
		});
		expect(popup?.args[1]).toContain('他说 \\"hi\\" \\\\ done');
	});

	it("builds notify-send / zenity commands on Linux", () => {
		const toast = buildPopupCommand("linux", "toast", baseContent);
		expect(toast?.command).toBe("notify-send");
		expect(toast?.args).toContain("MyHarness · my-project");

		const dialog = buildPopupCommand("linux", "window", baseContent);
		expect(dialog?.command).toBe("zenity");
		expect(dialog?.args.some((arg) => arg.startsWith("--text="))).toBe(true);
	});

	it("returns undefined for unsupported platforms", () => {
		expect(buildPopupCommand("freebsd", "toast", baseContent)).toBeUndefined();
	});
});

describe("interactive-mode popup hook", () => {
	const completedSnapshot: RunStateSnapshot = {
		state: "completed",
		activity: "任务完成",
		lastActivityAt: Date.now(),
		startedAt: Date.now() - 60_000,
		runId: 7,
	};

	function createContext(toggles: Partial<{ enabled: boolean; onCompleted: boolean; onError: boolean }> = {}) {
		const context = {
			shutdownRequested: false,
			lastPopupRunStateKey: undefined as string | undefined,
			settingsManager: {
				getPopupNotificationSettings: () => ({
					enabled: true,
					style: "toast" as const,
					onCompleted: true,
					onError: true,
					onInterrupted: true,
					...toggles,
				}),
			},
			sessionManager: { getCwd: () => "/tmp/my-project" },
		};
		(context as Record<string, unknown>).popupTitle = (
			InteractiveMode.prototype as unknown as Record<string, unknown>
		).popupTitle;
		return context as unknown as InteractiveMode;
	}

	function runHook(context: InteractiveMode, snapshot: RunStateSnapshot): void {
		(
			InteractiveMode.prototype as unknown as Record<string, (state: RunStateSnapshot) => void>
		).maybeShowPopupNotification.call(context, snapshot);
	}

	beforeEach(() => {
		showPopupMock.mockClear();
	});

	it("fires once per terminal outcome with kind, title and message", () => {
		const context = createContext();
		runHook(context, completedSnapshot);
		runHook(context, { ...completedSnapshot });

		expect(showPopupMock).toHaveBeenCalledTimes(1);
		expect(showPopupMock).toHaveBeenCalledWith("toast", {
			kind: "completed",
			title: "MyHarness · my-project",
			message: expect.stringContaining("任务完成"),
		});
	});

	it("does not fire for non-terminal states", () => {
		const context = createContext();
		runHook(context, { ...completedSnapshot, state: "running" });
		expect(showPopupMock).not.toHaveBeenCalled();
	});

	it("does not fire when disabled or when the outcome kind is muted", () => {
		runHook(createContext({ enabled: false }), completedSnapshot);
		runHook(createContext({ onCompleted: false }), completedSnapshot);
		runHook(createContext({ onError: false }), { ...completedSnapshot, state: "failed", runId: 8 });
		expect(showPopupMock).not.toHaveBeenCalled();
	});

	it("does not fire after shutdown was requested", () => {
		const context = createContext();
		(context as unknown as { shutdownRequested: boolean }).shutdownRequested = true;
		runHook(context, completedSnapshot);
		expect(showPopupMock).not.toHaveBeenCalled();
	});
});

describe("interactive-mode operation popup (/commit)", () => {
	function createContext(toggles: Partial<{ enabled: boolean; onCompleted: boolean; onError: boolean }> = {}) {
		const context = {
			shutdownRequested: false,
			settingsManager: {
				getPopupNotificationSettings: () => ({
					enabled: true,
					style: "toast" as const,
					onCompleted: true,
					onError: true,
					onInterrupted: true,
					...toggles,
				}),
			},
			sessionManager: { getCwd: () => "/tmp/my-project" },
		};
		(context as Record<string, unknown>).popupTitle = (
			InteractiveMode.prototype as unknown as Record<string, unknown>
		).popupTitle;
		return context as unknown as InteractiveMode;
	}

	function runOperationPopup(context: InteractiveMode, ok: boolean, message: string): void {
		(
			InteractiveMode.prototype as unknown as Record<string, (ok: boolean, message: string) => void>
		).showOperationPopup.call(context, ok, message);
	}

	beforeEach(() => {
		showPopupMock.mockClear();
	});

	it("fires a completed popup for a successful background commit", () => {
		runOperationPopup(createContext(), true, "Git 提交完成（3 个路径）");
		expect(showPopupMock).toHaveBeenCalledTimes(1);
		expect(showPopupMock).toHaveBeenCalledWith("toast", {
			kind: "completed",
			title: "MyHarness · my-project",
			message: "Git 提交完成（3 个路径）",
		});
	});

	it("fires a failed popup and honors the onError toggle", () => {
		runOperationPopup(createContext(), false, "Git 提交失败");
		expect(showPopupMock).toHaveBeenCalledTimes(1);
		expect(showPopupMock).toHaveBeenCalledWith("toast", {
			kind: "failed",
			title: "MyHarness · my-project",
			message: "Git 提交失败",
		});

		runOperationPopup(createContext({ onError: false }), false, "Git 提交失败");
		expect(showPopupMock).toHaveBeenCalledTimes(1);
	});
});
