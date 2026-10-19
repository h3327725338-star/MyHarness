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

it("opens new browser tabs without an address, and names a website tab after its page", () => {
	// The + button always adds a tab: an empty address is a new tab, never a second view of the one already open.
	const openBlank = [{ id: "browser:b-2", type: "browser", url: "" }];
	expect(model.browserTabId(openBlank, "")).not.toBe("browser:b-2");
	expect(model.browserTabId([], "")).toMatch(/^browser:/);

	// A saved new tab keeps its id but has no address yet; without an id it could not be told apart from another one.
	expect(model.normalizePanelTabs([{ type: "browser", url: "", id: "browser:b-3" }])).toEqual([
		{ id: "browser:b-3", type: "browser", url: "" },
	]);
	expect(model.normalizeWorkspaceTab({ type: "browser", url: "" })).toBe(null);
	expect(model.workspaceTabTitle({ id: "browser:b-3", type: "browser", url: "" })).toBe("New tab");

	// Once the page has a title, the tab reads like a browser tab instead of a bare host; the host is still the fallback.
	expect(
		model.workspaceTabTitle({
			id: "browser:b-4",
			type: "browser",
			url: "https://example.com/x",
			title: "Example Domain",
		}),
	).toBe("Example Domain");
	expect(model.workspaceTabTitle({ id: "browser:b-4", type: "browser", url: "https://example.com/x" })).toBe(
		"example.com",
	);
	// The title survives a reload of the app, so a restored tab does not flash its host first.
	expect(
		model.normalizeWorkspaceTab({
			id: "browser:b-5",
			type: "browser",
			url: "https://example.com/",
			title: "Example Domain",
		}),
	).toEqual({
		id: "browser:b-5",
		type: "browser",
		url: "https://example.com/",
		title: "Example Domain",
	});
});
