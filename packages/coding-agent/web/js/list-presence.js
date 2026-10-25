// Keep live rows in authoritative order, retaining exits just before their next surviving neighbour.
// Map/Set lookups make reconciliation linear rather than repeatedly scanning the entire list.
// `key` is the property that identifies a row (a chat has its `path`, a workspace or a toast its `id`), or a function
// that gives a row's identity.
export function reconcileRows(previous, current, key = "path") {
	const keyOf = typeof key === "function" ? key : (item) => item[key];
	const live = new Set(current.map(keyOf));
	const before = new Map();
	let exits = [];
	for (const item of previous) {
		if (!live.has(keyOf(item))) exits.push(item);
		else if (exits.length) { before.set(keyOf(item), exits); exits = []; }
	}
	const result = [];
	for (const item of current) {
		const removed = before.get(keyOf(item));
		if (removed) result.push(...removed);
		result.push(item);
	}
	return result.concat(exits);
}
