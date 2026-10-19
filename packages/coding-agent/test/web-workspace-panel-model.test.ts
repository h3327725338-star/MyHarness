import { expect, it } from "vitest";

// The workspace tab model is a plain ES module (browser code), loaded through a computed URL like the other web tests.
const model = await import(new URL("../web/js/workspace-model.js", import.meta.url).href);

it("keeps a conversation's panel empty instead of falling back to a panel tab", () => {
	expect(model.normalizePanelTabs([])).toEqual([]);
	expect(model.normalizePanelTabs(null)).toEqual([]);
	expect(
		model
			.normalizePanelTabs([{ type: "file", path: "a.ts" }, { type: "file", path: "a.ts" }, { type: "bogus" }])
			.map((tab: { id: string }) => tab.id),
	).toEqual(["file:a.ts"]);
	// The saved page preferences of earlier versions still fall back to one panel tab.
	expect(model.normalizeWorkspaceTabs([])).toEqual([{ id: "changes", type: "changes" }]);
});

it("gives one conversation one website tab per address, and another conversation its own", () => {
	const open = [{ id: "browser:b-1", type: "browser", url: "https://example.com/" }];
	expect(model.browserTabId(open, "https://example.com/")).toBe("browser:b-1");
	const first = model.browserTabId([], "https://example.com/");
	const second = model.browserTabId([], "https://example.com/");
	expect(first).toMatch(/^browser:/);
	// The id keys the native browser view in the desktop host: two conversations must never share one view.
	expect(first).not.toBe(second);
});
