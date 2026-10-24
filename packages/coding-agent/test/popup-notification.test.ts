import { describe, expect, it, vi } from "vitest";
import { sendDesktopNotification } from "../src/utils/popup-notification.ts";

const content = {
	kind: "completed" as const,
	title: "MyHarness · 任务成功完成 · DSA",
	message: "a\nb",
	tag: "myharness-task-s2",
};

describe("sendDesktopNotification", () => {
	it("hands the toast to the desktop host over IPC instead of PowerShell", () => {
		const send = vi.fn(() => true);
		expect(sendDesktopNotification(content, { MYHARNESS_DESKTOP_HOST: "1" }, { send, connected: true })).toBe(true);
		expect(send).toHaveBeenCalledWith({
			type: "myharness:notify",
			title: content.title,
			body: content.message,
			tag: "myharness-task-s2",
		});
	});

	it("declines outside the desktop app or when the IPC link is closed", () => {
		const send = vi.fn(() => true);
		expect(sendDesktopNotification(content, {}, { send, connected: true })).toBe(false);
		expect(sendDesktopNotification(content, { MYHARNESS_DESKTOP_HOST: "1" }, { connected: true })).toBe(false);
		expect(sendDesktopNotification(content, { MYHARNESS_DESKTOP_HOST: "1" }, { send, connected: false })).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("declines when the send throws (channel closed mid-call)", () => {
		const send = vi.fn(() => {
			throw new Error("channel closed");
		});
		expect(sendDesktopNotification(content, { MYHARNESS_DESKTOP_HOST: "1" }, { send, connected: true })).toBe(false);
	});
});
