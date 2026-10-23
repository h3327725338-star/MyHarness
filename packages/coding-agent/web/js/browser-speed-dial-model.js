// Layout operations of the built-in browser's new-tab shortcuts (browser-speed-dial.js), kept free of UI imports so
// they can be tested on their own. Every function returns a new list and leaves its input untouched.

const newId = () => `sd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Where a site is: its index at the top level, or its group's index and its index inside that group. */
export function locateSite(items, id) {
	for (const [index, item] of items.entries()) {
		if (item.type !== "group" && item.id === id) return { index, groupIndex: -1 };
		if (item.type === "group") {
			const inner = item.items.findIndex((site) => site.id === id);
			if (inner >= 0) return { index: inner, groupIndex: index };
		}
	}
	return null;
}

/** A group with one site left becomes that site again; an empty group disappears (as in the Start menu). */
export function tidyLayout(items) {
	return items.flatMap((item) => {
		if (item.type !== "group") return [item];
		if (item.items.length === 0) return [];
		if (item.items.length === 1) return [item.items[0]];
		return [item];
	});
}

/** The list without one site (wherever it is) and the site that was taken out. */
export function takeSite(items, id) {
	const where = locateSite(items, id);
	if (!where) return { items, site: null };
	if (where.groupIndex < 0) return { items: items.filter((_, index) => index !== where.index), site: items[where.index] };
	const group = items[where.groupIndex];
	const site = group.items[where.index];
	const next = items.map((item, index) => (index === where.groupIndex ? { ...item, items: item.items.filter((entry) => entry.id !== id) } : item));
	return { items: next, site };
}

/** Move a site (or a whole group) next to another top-level entry: before it, or after it. */
export function moveEntry(items, id, targetId, after = false) {
	if (id === targetId) return items;
	const top = items.find((item) => item.id === id);
	const { items: rest, entry } = top
		? { items: items.filter((item) => item.id !== id), entry: top }
		: (({ items: list, site }) => ({ items: list, entry: site }))(takeSite(items, id));
	if (!entry) return items;
	const at = rest.findIndex((item) => item.id === targetId);
	if (at < 0) return items;
	const next = [...rest];
	next.splice(after ? at + 1 : at, 0, entry);
	return tidyLayout(next);
}

/** Drop a site onto another site (a new group of both) or onto a group (it joins the group at the end). */
export function groupWith(items, id, targetId) {
	if (id === targetId) return items;
	const { items: rest, site } = takeSite(items, id);
	if (!site) return items;
	const at = rest.findIndex((item) => item.id === targetId);
	if (at < 0) return items;
	const target = rest[at];
	const next = [...rest];
	next[at] = target.type === "group" ? { ...target, items: [...target.items, site] } : { id: newId(), type: "group", title: "", items: [target, site] };
	return tidyLayout(next);
}

/** Move a site inside its group, before or after another site of the same group. */
export function moveInGroup(items, groupId, id, targetId, after = false) {
	return items.map((item) => {
		if (item.id !== groupId || item.type !== "group" || id === targetId) return item;
		const site = item.items.find((entry) => entry.id === id);
		if (!site) return item;
		const rest = item.items.filter((entry) => entry.id !== id);
		const at = rest.findIndex((entry) => entry.id === targetId);
		if (at < 0) return item;
		rest.splice(after ? at + 1 : at, 0, site);
		return { ...item, items: rest };
	});
}

/** Take a site out of its group and put it at the top level right after the group. */
export function ungroupSite(items, id) {
	const where = locateSite(items, id);
	if (!where || where.groupIndex < 0) return items;
	const groupId = items[where.groupIndex].id;
	const { items: rest, site } = takeSite(items, id);
	const at = rest.findIndex((item) => item.id === groupId);
	const next = [...rest];
	next.splice(at + 1, 0, site);
	return tidyLayout(next);
}

/** Every group's sites back at the top level, where the group was. */
export function dissolveGroup(items, groupId) {
	return items.flatMap((item) => (item.id === groupId && item.type === "group" ? item.items : [item]));
}

export function removeEntry(items, id) {
	if (items.some((item) => item.id === id)) return items.filter((item) => item.id !== id);
	return tidyLayout(takeSite(items, id).items);
}

/** Add a new site at the end (of a group when one is named) or change an existing one's name and address. */
export function upsertSite(items, { id, title, url, groupId }) {
	if (id) {
		const change = (site) => (site.id === id ? { ...site, title, url, ...(site.url !== url ? { icon: undefined, noIcon: undefined } : {}) } : site);
		return items.map((item) => (item.type === "group" ? { ...item, items: item.items.map(change) } : change(item)));
	}
	const site = { id: newId(), type: "site", title, url };
	if (groupId) return items.map((item) => (item.id === groupId && item.type === "group" ? { ...item, items: [...item.items, site] } : item));
	return [...items, site];
}

export function renameGroup(items, groupId, title) {
	return items.map((item) => (item.id === groupId && item.type === "group" ? { ...item, title } : item));
}

/** A typed address as the page would open it: a bare host gets https://; anything else must already be http(s). */
export function shortcutUrl(value) {
	const text = String(value || "").trim();
	if (!text) return "";
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
	} catch {
		return "";
	}
}
