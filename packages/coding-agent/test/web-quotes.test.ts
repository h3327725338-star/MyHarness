import { describe, expect, it } from "vitest";

const webDir = new URL("../web/js/", import.meta.url);

describe("Web UI: quote and reference feature", () => {
	it("serializes and deserializes quotes in drafts", async () => {
		const { draftFromServer, draftToServer, draftHasContent } = await import(new URL("chat-modes.js", webDir).href);

		const quotes = [
			{ id: "q-1", text: "const a = 1;\nconst b = 2;" },
			{ id: "q-2", text: "function handleAuth() { return true; }" },
		];

		const draft = draftToServer({
			text: "用户输入的问题",
			images: [],
			quotes,
		});

		expect(draft.quotes).toEqual(quotes);
		expect(draftHasContent(draft)).toBe(true);

		const restored = draftFromServer(JSON.parse(JSON.stringify(draft)));
		expect(restored).not.toBeNull();
		expect(restored?.quotes).toEqual(quotes);
		expect(restored?.text).toBe("用户输入的问题");
	});

	it("keeps a saved quote's note and where it was picked through the draft round trip", async () => {
		const { draftFromServer, draftToServer } = await import(new URL("chat-modes.js", webDir).href);

		const quotes = [{ id: "q-1", text: "const x = 1;", note: "这段要改成可配置", hint: 42 }];
		const saved = draftToServer({ text: "", images: [], quotes });
		expect(saved.quotes).toEqual(quotes);
		expect(draftFromServer(JSON.parse(JSON.stringify(saved)))?.quotes).toEqual(quotes);

		// An empty note or a zero hint is not carried around as noise: the plain quote shape stays the same.
		expect(
			draftToServer({ text: "", images: [], quotes: [{ id: "q-2", text: "y", note: "  ", hint: 0 }] }).quotes,
		).toEqual([{ id: "q-2", text: "y" }]);
	});

	it("treats drafts containing only quotes as having content", async () => {
		const { draftToServer, draftHasContent } = await import(new URL("chat-modes.js", webDir).href);

		const emptyWithQuotes = draftToServer({
			text: "",
			images: [],
			quotes: [{ id: "q-1", text: "只引用了一段代码" }],
		});

		expect(draftHasContent(emptyWithQuotes)).toBe(true);
	});

	it("formats a quote as a block quote, with the reader's note under it", async () => {
		const { clipLine, formatQuote, formatQuotes, quoteNote, quotePreview } = await import(
			new URL("quote-text.js", webDir).href
		);

		expect(formatQuote({ text: "const x = 10;\nconst y = 20;" })).toBe("> const x = 10;\n> const y = 20;");
		expect(formatQuote({ text: "单行引用", note: "  看这里  " })).toBe("> 单行引用\n\n看这里");
		expect(formatQuote({ text: "", note: "没有正文" })).toBe("没有正文");

		const combined = formatQuotes([
			{ id: "q-1", text: "const x = 10;\nconst y = 20;" },
			{ id: "q-2", text: "单行引用", note: "注释" },
		]);
		expect(combined).toBe("> const x = 10;\n> const y = 20;\n\n> 单行引用\n\n注释");
		expect(formatQuotes([])).toBe("");

		expect(quoteNote({ text: "a" })).toBe("");
		expect(quotePreview({ text: "原文内容", note: "批注内容" })).toBe("批注内容");
		expect(quotePreview({ text: "原文内容" })).toBe("原文内容");
		expect(clipLine("一\n二", 1)).toBe("一");
		expect(clipLine("abcdefghij", 4)).toBe("abcd…");
	});

	it("mounts a saved quote with its note and search hint", async () => {
		// The bubble's only job: hand the passage to the composer. It never sends anything itself (see the browser test).
		const { quoteFromSelection } = await import(new URL("quote-text.js", webDir).href);
		expect(quoteFromSelection("  const flag = true;  ", { note: "这里加开关", hint: 17 })).toEqual({
			text: "const flag = true;",
			note: "这里加开关",
			hint: 17,
			id: expect.any(String),
		});
		expect(quoteFromSelection("   ")).toBeNull();
	});
});
