// Static layout locks for the expanded tool cards: one scroll viewport, arguments and result rendered
// flat inside the shell, and the agent call's own details expanding directly under its row, ahead of the task list.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const transcriptSrc = readFileSync(new URL("../web/js/transcript.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/css/transcript.css", import.meta.url), "utf8");

describe("Expanded tool card layout", () => {
	it("keeps one main scroll viewport with flat argument and result sections", () => {
		expect(transcriptSrc).toMatch(
			/<div class="raw-body">\s*<div class="raw-section">\s*<div class="raw-label">\$\{t\("Arguments"\)\}<\/div>/,
		);
		expect(transcriptSrc).toMatch(/`raw-section\$\{result\?\.isError \? " raw-err" : ""\}/);
		expect(css).toMatch(/\.raw-body \{[^}]*max-height[^}]*overflow-y: auto[^}]*\}/);
		expect(css).toMatch(/\.raw-section \{[^}]*background: transparent[^}]*border: none[^}]*\}/);
		expect(css).not.toMatch(/\.raw-section \{[^}]*border: 1px solid/);
		// The nested scrollers are gone: the wheel anywhere inside the card drives the single .raw-body viewport.
		expect(css).not.toMatch(/\.raw-pre \{[^}]*max-height/);
		expect(css).not.toMatch(/\.raw-md \{[^}]*max-height/);
	});
	it("keeps the flattened sections compact (anti-rebound)", () => {
		const sectionRule = /\.raw-section \{([^}]*)\}/.exec(css)?.[1] ?? "";
		const sectionMarginTop = Number(/margin-top: ([\d.]+)px/.exec(sectionRule)?.[1]);
		expect(sectionMarginTop).toBeLessThanOrEqual(6);
		expect(css).toMatch(/\.raw-section:first-child \{ margin-top: 0; \}/);
		for (const rule of css.matchAll(/\.raw-pre \{([^}]*)\}/g)) {
			const padding = /padding: ([\d.]+)px(?: ([\d.]+)px(?: ([\d.]+)px)?)?/.exec(rule[1]);
			const top = Number(padding?.[1]);
			// Two-value shorthand repeats the first value vertically; three-value has an explicit bottom.
			const bottom = padding?.[3] !== undefined ? Number(padding[3]) : top;
			expect(top).toBeLessThanOrEqual(6);
			expect(bottom).toBeLessThanOrEqual(6);
		}
	});
	it("expands an agent call directly under its row, ahead of the sub-agent task list", () => {
		const openRaw = transcriptSrc.search(
			/<\$\{Collapse\} open=\$\{open\}><\$\{RawDetails\} step=\$\{step\} \/><\/\/>/,
		);
		const taskList = transcriptSrc.search(/<\$\{AgentDetails\} details=\$\{liveDetails\} \/>/);
		expect(openRaw).toBeGreaterThan(-1);
		expect(taskList).toBeGreaterThan(-1);
		expect(openRaw).toBeLessThan(taskList);
	});
	it("dropped the edit estimate mechanism from the wire and the browser", () => {
		const sources = [
			"../web/js/turns.js",
			"../web/js/transcript.js",
			"../web/js/step-counts.js",
			"../src/modes/web/wire.ts",
		]
			.map((url) => readFileSync(new URL(url, import.meta.url), "utf8"))
			.join("\n");
		expect(sources).not.toMatch(/changePreview|editChangePreview|count-preview/);
	});
});
