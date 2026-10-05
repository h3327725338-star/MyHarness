import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { modeIconPaths } = await import(new URL("../web/js/mode-icon.js", import.meta.url).href);
const css = readFileSync(new URL("../web/css/tokens.css", import.meta.url), "utf8");

function palette(theme: string, scheme = "amber") {
	const get = resolved(theme, scheme);
	return Object.fromEntries(
		[
			"bg-app",
			"bg-panel",
			"bg-raised",
			"text",
			"text-2",
			"text-3",
			"text-4",
			"border",
			"border-strong",
			"accent",
			"on-accent",
		].map((key) => [key, get(key)]),
	);
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

// Resolve the base display palette and the chosen scheme, independently of chat mode.
function block(selector: string) {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) return {} as Record<string, string>;
	const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
function resolved(theme: string, scheme: string) {
	const values: Record<string, string> = {
		...block(":root"),
		...block(`:root[data-theme="${theme}"]`),
		...block(`:root[data-theme="${theme}"][data-color-theme="${scheme}"]`),
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

describe("All selectable palettes stay readable", () => {
	const palettes = (["dark", "light"] as const).flatMap((theme) =>
		(["classic", "forest", "amber"] as const).map((scheme) => ({
			name: `${scheme} ${theme}`,
			get: resolved(theme, scheme),
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
	it("does not couple surface colors to chat mode", () => {
		expect(css).not.toContain('[data-chat-mode="general"]');
		for (const scheme of ["forest", "amber"]) {
			expect(palette("light", scheme)).toEqual(palette("light", "classic"));
		}
	});
	it("restores the saved forest preview and retains classic charcoal", () => {
		expect(palette("dark", "forest")["bg-panel"]).toBe("#292e2b");
		expect(palette("dark", "forest").accent).toBe("#a7c080");
		expect(palette("dark", "classic")["bg-panel"]).toBe("#1c1d1d");
		expect(palette("dark", "classic").accent).toBe("#79a8f5");
	});
});

describe("Warm Amber dark palette", () => {
	it("separates warm charcoal surface tiers without saturated brown backgrounds", () => {
		const p = palette("dark");
		expect(p["bg-panel"]).toBe("#302b28");
		expect(p.accent).toBe("#d4ae82");
		for (const [lower, upper] of [
			["bg-app", "bg-panel"],
			["bg-panel", "bg-raised"],
		]) {
			expect(luminance(p[lower])).toBeLessThan(luminance(p[upper]));
			expect(contrast(p[lower], p[upper])).toBeGreaterThanOrEqual(1.15);
		}
		for (const surface of ["bg-app", "bg-panel", "bg-raised"]) {
			const [r, g, b] = hex3(p[surface]);
			expect(r).toBeGreaterThan(g);
			expect(g).toBeGreaterThan(b);
			expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(12);
			expect(p[surface]).not.toBe(resolved("dark", "classic")(surface));
		}
	});
	it("keeps body text soft-white and limits warm tint in secondary text and borders", () => {
		const p = palette("dark");
		const body = hex3(p.text);
		expect(Math.max(...body) - Math.min(...body)).toBeLessThanOrEqual(8);
		for (const token of ["text-2", "text-3", "text-4", "border", "border-strong"]) {
			const channels = hex3(p[token]);
			expect(Math.max(...channels) - Math.min(...channels), token).toBeLessThanOrEqual(24);
		}
	});
	it("maps each switch side to its own saved dark theme accent", () => {
		for (const mode of ["coding", "general"]) {
			for (const scheme of ["forest", "amber"]) {
				expect(block(`:root[data-theme="dark"][data-${mode}-color-theme="${scheme}"]`)[`mode-${mode}`]).toBe(
					palette("dark", scheme).accent,
				);
			}
		}
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
