import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const { COLOR_THEMES, colorThemeOf, modeColorThemesOf } = await import(
	new URL("../web/js/appearance-themes.js", import.meta.url).href
);
const boot = readFileSync(new URL("../web/js/boot-theme.js", import.meta.url), "utf8");

function bootPrefs(prefs: unknown, systemDark = true) {
	const root = { dataset: {} as Record<string, string>, lang: "" };
	runInNewContext(boot, {
		document: { documentElement: root },
		localStorage: { getItem: () => (typeof prefs === "string" ? prefs : JSON.stringify(prefs)) },
		matchMedia: () => ({ matches: systemDark }),
	});
	return root.dataset;
}

describe("browser color theme preferences", () => {
	it("migrates the shared preference without losing it and respects separate selections", () => {
		expect(modeColorThemesOf({ colorTheme: "forest" })).toEqual({ coding: "forest", general: "forest" });
		expect(modeColorThemesOf({ colorTheme: "forest", colorThemes: { coding: "classic", general: "amber" } })).toEqual(
			{ coding: "classic", general: "amber" },
		);
		for (const chatMode of ["coding", "general"]) {
			const prefs = { chatMode, theme: "dark", colorThemes: { coding: "classic", general: "amber" } };
			expect(bootPrefs(prefs).colorTheme).toBe(chatMode === "coding" ? "classic" : "amber");
			expect(bootPrefs(prefs)).toMatchObject({ codingColorTheme: "classic", generalColorTheme: "amber" });
		}
	});
	it("offers exactly three schemes and defaults old or invalid preferences to classic", () => {
		expect(COLOR_THEMES.map((theme: { value: string }) => theme.value)).toEqual(["classic", "forest", "amber"]);
		for (const value of [undefined, null, "unknown", {}, 1]) expect(colorThemeOf(value)).toBe("classic");
		for (const { value } of COLOR_THEMES) expect(colorThemeOf(value)).toBe(value);
	});
	it("applies the saved scheme before first paint in either chat mode", () => {
		for (const colorTheme of ["classic", "forest", "amber"]) {
			for (const chatMode of ["coding", "general"]) {
				expect(bootPrefs({ colorTheme, chatMode, theme: "dark" })).toMatchObject({
					colorTheme,
					chatMode,
					theme: "dark",
				});
			}
		}
	});
	it("keeps display mode independent and retains the selected scheme in light mode", () => {
		expect(bootPrefs({ colorTheme: "forest", theme: "light" })).toMatchObject({
			colorTheme: "forest",
			theme: "light",
		});
		expect(bootPrefs({ colorTheme: "amber", theme: "system" }, false)).toMatchObject({
			colorTheme: "amber",
			theme: "light",
		});
	});
	it("handles missing, invalid and damaged saved preferences", () => {
		for (const prefs of [{}, { colorTheme: "missing" }, "invalid json", "null"]) {
			expect(bootPrefs(prefs).colorTheme).toBe("classic");
		}
	});
});
