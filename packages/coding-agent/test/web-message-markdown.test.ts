import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function renderer() {
	const context = vm.createContext({
		Component: class {},
		t: (text: string) => text,
		looseStrong: () => null,
	});
	vm.runInContext(readFileSync(new URL("../src/exports/html/vendor/marked.min.js", import.meta.url), "utf8"), context);
	const source = readFileSync(new URL("../web/js/markdown.js", import.meta.url), "utf8");
	vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
	return context.renderMarkdown as (text: string, options?: { breaks: boolean }) => string;
}

describe("user message Markdown line breaks", () => {
	it("preserves LF and CRLF line breaks without changing normal Markdown or sharing its cache", () => {
		const render = renderer();
		for (const text of ["在吗?\n在吗?\n在吗?", "在吗?\r\n在吗?\r\n在吗?"]) {
			expect(render(text)).not.toContain("<br>");
			expect(render(text, { breaks: true })).toBe("<p>在吗?<br>在吗?<br>在吗?</p>\n");
			expect(render(text)).not.toContain("<br>");
		}
	});

	it("keeps headings, lists, bold, paragraphs and code formatting, and escapes raw HTML", () => {
		const render = renderer();
		const html = render(
			"# Heading\n\n- first\n- second\n\n**bold**\nnext\n\n```ts\nline1\nline2\n```\n\n<script>bad()</script>",
			{ breaks: true },
		);
		expect(html).toContain("<h1>Heading</h1>");
		expect(html).toContain("<li>first</li>");
		expect(html).toContain("<li>second</li>");
		expect(html).toContain("<strong>bold</strong><br>next");
		expect(html).toContain("line1\nline2");
		expect(html).not.toContain("line1<br>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
});
