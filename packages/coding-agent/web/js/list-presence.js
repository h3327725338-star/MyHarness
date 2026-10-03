// Keep live rows in authoritative order, retaining exits just before their next surviving neighbour.
// Map/Set lookups make reconciliation linear rather than repeatedly scanning the entire list.
export function reconcileRows(previous, current) {
	const live = new Set(current.map((item) => item.path));
	const before = new Map();
	let exits = [];
	for (const item of previous) {
		if (!live.has(item.path)) exits.push(item);
		else if (exits.length) { before.set(item.path, exits); exits = []; }
	}
	const result = [];
	for (const item of current) {
		const removed = before.get(item.path);
		if (removed) result.push(...removed);
		result.push(item);
	}
	return result.concat(exits);
}
