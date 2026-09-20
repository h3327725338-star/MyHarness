import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";

describe("SettingsManager popup notification settings", () => {
	it("defaults to enabled toast popups for every outcome kind", () => {
		const manager = SettingsManager.inMemory({});
		expect(manager.getPopupNotificationSettings()).toEqual({
			enabled: true,
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
			style: "window",
			onCompleted: false,
			onError: true,
			onInterrupted: true,
		});
	});
});
