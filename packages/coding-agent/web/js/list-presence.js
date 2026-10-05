// Keep live rows in authoritative order, retaining exits just before their next surviving neighbour.
// Map/Set lookups make reconciliation linear rather than repeatedly scanning the entire list.
// `key` is the property that identifies a row (a chat has its `path`, a workspace or a toast its `id`).
export function reconcileRows(previous, current, key = "path") {
	const live = new Set(current.map((item) => item[key]));
	const before = new Map();
	let exits = [];
	for (const item of previous) {
		if (!live.has(item[key])) exits.push(item);
		else if (exits.length) { before.set(item[key], exits); exits = []; }
	}
	const result = [];
	for (const item of current) {
		const removed = before.get(item[key]);
		if (removed) result.push(...removed);
		result.push(item);
	}
	return result.concat(exits);
}
