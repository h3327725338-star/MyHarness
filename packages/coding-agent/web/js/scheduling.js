// Cooperative work scheduling shared by expensive client-side searches.
export function yieldToMain() {
	return globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}

// Read cache entries synchronously, then revalidate without duplicating in-flight reads.
// Keys must include the workspace/session boundary of the resource.
export function createReadCache(limit = 100) {
	const entries = new Map();
	return {
		peek(key) { return entries.get(key)?.value; },
		load(key, read) {
			let entry = entries.get(key);
			if (entry?.pending) return entry.pending;
			if (!entry) entry = {};
			entries.delete(key);
			entries.set(key, entry);
			entry.pending = Promise.resolve().then(read).then((value) => {
				entry.value = value;
				return value;
			}).finally(() => {
				entry.pending = null;
				for (const [oldKey, old] of entries) {
					if (entries.size <= limit) break;
					if (!old.pending) entries.delete(oldKey);
				}
			});
			return entry.pending;
		},
	};
}
