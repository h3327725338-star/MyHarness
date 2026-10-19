import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";

describe("SettingsManager popup notification settings", () => {
	it("defaults to enabled toast popups for every outcome kind", () => {
		const manager = SettingsManager.inMemory({});
		expect(manager.getPopupNotificationSettings()).toEqual({
			enabled: true,
			turnComplete: "always",
			onQuestion: true,
			onPermission: true,
			sound: "soft",
			style: "toast",
			onCompleted: true,
			onError: true,
			onInterrupted: true,
		});
	});

	it("applies explicit settings and keeps defaults for unspecified kinds", () => {
		const manager = SettingsManager.inMemory({
			popupNotifications: { enabled: true, style: "window", onCompleted: false },
		});
		expect(manager.getPopupNotificationSettings()).toEqual({
			enabled: true,
			turnComplete: "always",
			onQuestion: true,
			onPermission: true,
			sound: "soft",
			style: "window",
			onCompleted: false,
			onError: true,
			onInterrupted: true,
		});
	});

	it("reads the legacy enabled switch as the task completion mode and keeps questions and permissions separate", () => {
		const manager = SettingsManager.inMemory({ popupNotifications: { enabled: false } });
		expect(manager.getPopupNotificationSettings()).toMatchObject({
			enabled: false,
			turnComplete: "never",
			onQuestion: true,
			onPermission: true,
		});
	});

	it("saves the notification choices", () => {
		const manager = SettingsManager.inMemory({});
		manager.setTurnCompleteNotifyMode("unfocused");
		manager.setNotifyOnQuestion(false);
		manager.setNotifyOnPermission(false);
		manager.setNotificationSound("glow");
		expect(manager.getPopupNotificationSettings()).toMatchObject({
			enabled: true,
			turnComplete: "unfocused",
			onQuestion: false,
			onPermission: false,
			sound: "glow",
		});
	});
});
