// Static layout locks for the expanded tool cards: one scroll viewport with separate argument/result
// cards, and the agent call's own details expanding directly under its row, ahead of the task list.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const transcriptSrc = readFileSync(new URL("../web/js/transcript.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/css/transcript.css", import.meta.url), "utf8");

describe("Expanded tool card layout", () => {
	it("keeps one main scroll viewport with separate cards for arguments and result", () => {
		expect(transcriptSrc).toMatch(
			/<div class="raw-body">\s*<div class="raw-section">\s*<div class="raw-label">\$\{t\("Arguments"\)\}<\/div>/,
		);
		expect(transcriptSrc).toMatch(/`raw-section\$\{result\?\.isError \? " raw-err" : ""\}/);
		expect(css).toMatch(/\.raw-body \{[^}]*max-height[^}]*overflow-y: auto[^}]*\}/);
		expect(css).toMatch(
			/\.raw-section \{[^}]*background: var\(--bg-raised\)[^}]*border: 1px solid var\(--border\)[^}]*\}/,
		);
		// The nested scrollers are gone: the wheel anywhere inside the card drives the single .raw-body viewport.
		expect(css).not.toMatch(/\.raw-pre \{[^}]*max-height/);
		expect(css).not.toMatch(/\.raw-md \{[^}]*max-height/);
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
