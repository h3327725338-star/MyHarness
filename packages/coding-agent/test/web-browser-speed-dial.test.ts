import { describe, expect, it } from "vitest";

// The new-tab shortcuts' layout rules are a plain ES module; load it through a computed URL like the other web tests.
const model = await import(new URL("../web/js/browser-speed-dial-model.js", import.meta.url).href);

const site = (id: string, url = `https://${id}.example/`) => ({ id, type: "site", title: id, url });
const ids = (items: Array<{ id: string; type: string; items?: Array<{ id: string }> }>) =>
	items.map((item) => (item.type === "group" ? `[${item.items!.map((entry) => entry.id).join(",")}]` : item.id));

describe("built-in browser: new-tab shortcuts", () => {
	it("makes a group when one shortcut is dropped on another, and adds to an existing group", () => {
		const start = [site("a"), site("b"), site("c")];
		const grouped = model.groupWith(start, "c", "a");
		expect(ids(grouped)).toEqual(["[a,c]", "b"]);
		expect(grouped[0].type).toBe("group");
		const joined = model.groupWith(grouped, "b", grouped[0].id);
		expect(ids(joined)).toEqual(["[a,c,b]"]);
		// The input list is never changed in place.
		expect(ids(start)).toEqual(["a", "b", "c"]);
	});

	it("reorders shortcuts and whole groups before or after another entry", () => {
		const start = [site("a"), site("b"), site("c")];
		expect(ids(model.moveEntry(start, "c", "a"))).toEqual(["c", "a", "b"]);
		expect(ids(model.moveEntry(start, "a", "c", true))).toEqual(["b", "c", "a"]);
		const grouped = model.groupWith(start, "b", "a");
		expect(ids(model.moveEntry(grouped, grouped[0].id, "c", true))).toEqual(["c", "[a,b]"]);
	});

	it("dissolves a group that is left with one shortcut, like the Start menu", () => {
		const grouped = model.groupWith([site("a"), site("b"), site("c")], "b", "a");
		expect(ids(model.ungroupSite(grouped, "b"))).toEqual(["a", "b", "c"]);
		expect(ids(model.removeEntry(grouped, "a"))).toEqual(["b", "c"]);
		// Dragging a grouped shortcut onto a top-level one takes it out of its group.
		expect(ids(model.moveEntry(grouped, "a", "c", true))).toEqual(["b", "c", "a"]);
		expect(ids(model.dissolveGroup(model.groupWith(grouped, "c", grouped[0].id), grouped[0].id))).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("reorders inside a group and renames it", () => {
		const group = model.groupWith([site("a"), site("b"), site("c")], "b", "a")[0];
		const three = model.groupWith([group, site("c")], "c", group.id);
		const moved = model.moveInGroup(three, group.id, "c", "a");
		expect(ids(moved)).toEqual(["[c,a,b]"]);
		expect(model.renameGroup(moved, group.id, "Work")[0].title).toBe("Work");
	});

	it("adds and edits shortcuts; a changed address drops the old site icon", () => {
		const added = model.upsertSite([], { title: "Mail", url: "https://mail.example/" });
		expect(added).toHaveLength(1);
		const withIcon = [{ ...added[0], icon: "data:image/png;base64,AA==" }];
		const renamed = model.upsertSite(withIcon, { id: added[0].id, title: "Post", url: "https://mail.example/" });
		expect(renamed[0]).toMatchObject({ title: "Post", icon: "data:image/png;base64,AA==" });
		const moved = model.upsertSite(withIcon, { id: added[0].id, title: "Post", url: "https://other.example/" });
		expect(moved[0].icon).toBeUndefined();
	});

	it("accepts bare hosts and http(s) addresses only", () => {
		expect(model.shortcutUrl("github.com")).toBe("https://github.com/");
		expect(model.shortcutUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
		expect(model.shortcutUrl("javascript:alert(1)")).toBe("");
		expect(model.shortcutUrl("file:///C:/")).toBe("");
		expect(model.shortcutUrl("  ")).toBe("");
	});
});
