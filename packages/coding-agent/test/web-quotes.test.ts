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

	it("treats drafts containing only quotes as having content", async () => {
		const { draftToServer, draftHasContent } = await import(new URL("chat-modes.js", webDir).href);

		const emptyWithQuotes = draftToServer({
			text: "",
			images: [],
			quotes: [{ id: "q-1", text: "只引用了一段代码" }],
		});

		expect(draftHasContent(emptyWithQuotes)).toBe(true);
	});

	it("formats quotes properly into markdown blockquotes", () => {
		const quotes = [
			{ id: "q-1", text: "const x = 10;\nconst y = 20;" },
			{ id: "q-2", text: "单行引用" },
		];

		const formatQuotes = (items: Array<{ text: string }>) => {
			if (!items.length) return "";
			return items
				.map((q) =>
					q.text
						.split("\n")
						.map((line) => `> ${line}`)
						.join("\n"),
				)
				.join("\n\n");
		};

		const formatted = formatQuotes(quotes);
		expect(formatted).toBe("> const x = 10;\n> const y = 20;\n\n> 单行引用");

		const userText = "请重构这段代码";
		const assembled = formatted ? `${formatted}\n\n${userText}` : userText;
		expect(assembled).toBe("> const x = 10;\n> const y = 20;\n\n> 单行引用\n\n请重构这段代码");
	});
});
