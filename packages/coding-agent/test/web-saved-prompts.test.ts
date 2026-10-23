import { describe, expect, it } from "vitest";

// The stored-prompt rules are a plain ES module; load it through a computed URL like the other web tests.
const prompts = await import(new URL("../web/js/saved-prompts.js", import.meta.url).href);

describe("Session panel: My prompts", () => {
	it("keeps titled prompts and titles the bare strings earlier versions stored after their first line", () => {
		const loaded = prompts.savedPromptsOf([
			"\n  Review this diff for bugs\nand list them by severity",
			{ title: "  Translate  ", text: "Translate the reply into English" },
			{ title: "", text: "Summarise the thread" },
			"   ",
			{ title: "No text", text: "" },
			42,
			null,
		]);
		expect(loaded).toEqual([
			{ title: "Review this diff for bugs", text: "\n  Review this diff for bugs\nand list them by severity" },
			{ title: "Translate", text: "Translate the reply into English" },
			{ title: "Summarise the thread", text: "Summarise the thread" },
		]);
		expect(prompts.savedPromptsOf(undefined)).toEqual([]);
	});

	it("shortens a long first line into a title", () => {
		const title = prompts.promptTitleFrom("x".repeat(100));
		expect(title).toHaveLength(60);
		expect(title.endsWith("…")).toBe(true);
	});
});
