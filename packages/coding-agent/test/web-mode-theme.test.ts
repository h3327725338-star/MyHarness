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

// The four palettes as the browser resolves them: the base, the theme on top of it, and for General its own overrides.
function block(selector: string) {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) return {} as Record<string, string>;
	const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
function resolved(theme: string, mode: "coding" | "general") {
	const values: Record<string, string> = {
		...block(":root"),
		...block(`:root[data-theme="${theme}"]`),
		...(mode === "general" ? block(`:root[data-theme="${theme}"][data-chat-mode="general"]`) : {}),
	};
	const get = (name: string): string => {
		const value = values[name];
		const reference = value?.match(/^var\(--([\w-]+)\)$/);
		return reference ? get(reference[1]) : value;
	};
	return get;
}
function rgba(value: string): [number, number, number, number] {
	if (value.startsWith("#")) return [...hex3(value), 1];
	const [r, g, b, a = "1"] = value
		.match(/rgba?\(([^)]+)\)/)![1]
		.split(",")
		.map((part) => part.trim());
	return [Number(r), Number(g), Number(b), Number(a)];
}
const hex3 = (value: string) =>
	value
		.slice(1)
		.match(/../g)!
		.map((c) => Number.parseInt(c, 16)) as [number, number, number];
const toHex = (c: number[]) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
/** A translucent colour laid over a surface, as the browser paints it. */
function over(color: string, surface: string) {
	const [r, g, b, a] = rgba(color);
	const base = hex3(surface);
	return toHex([r, g, b].map((channel, i) => channel * a + base[i] * (1 - a)));
}

describe("Coding and General palettes read alike", () => {
	const palettes = (["dark", "light"] as const).flatMap((theme) =>
		(["coding", "general"] as const).map((mode) => ({
			name: `${mode} ${theme}`,
			theme,
			mode,
			get: resolved(theme, mode),
		})),
	);
	for (const { name, get } of palettes) {
		it(`${name}: the quiet text levels stay readable on every surface`, () => {
			for (const surface of ["bg-app", "bg-panel", "bg-raised"]) {
				expect(contrast(get("text-3"), get(surface)), `text-3 on ${surface}`).toBeGreaterThanOrEqual(4.5);
				expect(contrast(get("text-4"), get(surface)), `text-4 on ${surface}`).toBeGreaterThanOrEqual(3);
			}
			// The time of the selected chat uses text-3 (layout.css), because that row is on a lighter surface.
			expect(contrast(get("text-3"), get("surface-select"))).toBeGreaterThanOrEqual(4);
		});
		it(`${name}: status text is readable on its own tinted background`, () => {
			for (const status of ["ok", "warn", "danger"]) {
				for (const surface of ["bg-panel", "bg-raised"]) {
					const tint = over(get(`${status}-soft`), get(surface));
					expect(contrast(get(status), tint), `${status} on ${surface}`).toBeGreaterThanOrEqual(4);
				}
			}
			expect(contrast(get("on-danger"), get("danger")), "text on the solid danger button").toBeGreaterThanOrEqual(3);
		});
		it(`${name}: control borders can be seen`, () => {
			expect(contrast(get("border-strong"), get("bg-panel"))).toBeGreaterThanOrEqual(1.6);
		});
	}
	for (const theme of ["dark", "light"] as const) {
		it(`${theme}: both modes keep the same contrast tiers for the quiet text levels`, () => {
			const coding = resolved(theme, "coding");
			const general = resolved(theme, "general");
			for (const level of ["text-3", "text-4"]) {
				const gap = Math.abs(
					contrast(coding(level), coding("bg-panel")) - contrast(general(level), general("bg-panel")),
				);
				expect(gap, level).toBeLessThanOrEqual(1.5);
			}
		});
	}
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
