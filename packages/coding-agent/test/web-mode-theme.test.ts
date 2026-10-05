import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { modeIconPaths } = await import(new URL("../web/js/mode-icon.js", import.meta.url).href);
const css = readFileSync(new URL("../web/css/tokens.css", import.meta.url), "utf8");

function palette(theme: string) {
	const block = css.split(`:root[data-theme="${theme}"][data-chat-mode="general"] {`)[1].split("}")[0];
	return Object.fromEntries([...block.matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map((m) => [m[1], m[2]]));
}
function luminance(hex: string) {
	const channels = hex
		.slice(1)
		.match(/../g)!
		.map((c) => {
			const n = Number.parseInt(c, 16) / 255;
			return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
		});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string) {
	const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("mode icon morph", () => {
	it("keeps matching path topology throughout both directions", () => {
		const commands = (d: string) => d.match(/[MLQZ]/g);
		const coding = modeIconPaths(0);
		const general = modeIconPaths(1);
		expect(coding).not.toEqual(general);
		for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
			modeIconPaths(progress).forEach((d: string, i: number) => {
				expect(commands(d)).toEqual(commands(coding[i]));
				expect(d).not.toMatch(/NaN|undefined|Infinity/);
			});
		}
		expect(modeIconPaths(-1)).toEqual(coding);
		expect(modeIconPaths(2)).toEqual(general);
	});
	it("moves path coordinates continuously, rather than swapping icons", () => {
		const numbers = (d: string) => d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
		modeIconPaths(0.5).forEach((d: string, i: number) => {
			const a = numbers(modeIconPaths(0)[i]);
			const b = numbers(modeIconPaths(1)[i]);
			numbers(d).forEach((n, j) => {
				expect(n).toBeCloseTo((a[j] + b[j]) / 2, 3);
			});
		});
	});
});

describe("General Nord palette", () => {
	it("has distinct dark surfaces and a frost accent", () => {
		const p = palette("dark");
		expect(p["bg-panel"]).toBe("#2e3440");
		expect(luminance(p["bg-app"])).toBeLessThan(luminance(p["bg-panel"]));
		expect(p.accent).toBe("#88c0d0");
		expect(new Set([p["bg-app"], p["bg-panel"], p["bg-raised"]]).size).toBe(3);
	});
	for (const theme of ["dark", "light"]) {
		it(`keeps text and accent readable in ${theme} mode`, () => {
			const p = palette(theme);
			for (const surface of ["bg-app", "bg-panel", "bg-raised"]) {
				for (const text of ["text", "text-2", "text-3"])
					expect(contrast(p[text], p[surface])).toBeGreaterThanOrEqual(4.5);
				expect(contrast(p.accent, p[surface])).toBeGreaterThanOrEqual(3);
			}
			expect(contrast(p["on-accent"], p.accent)).toBeGreaterThanOrEqual(4.5);
		});
	}
});
