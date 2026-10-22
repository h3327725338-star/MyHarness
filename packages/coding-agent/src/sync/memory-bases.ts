import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, nowIso, readJsonFile, sha256, shortHash, writeJsonFile } from "./util.ts";

/**
 * The last content both devices had for a memory.
 *
 * A three-way merge needs the common ancestor; without it, two independent edits can only be appended, which loses the
 * document structure. This store keeps that ancestor per key. It is written only when a version is committed (applied
 * from another device or published from here), so it always describes a version both sides have seen.
 *
 * Everything lives below the agent directory, one content file per hash, and is never uploaded.
 */

interface StoredBase {
	hash: string;
	file: string;
	at: string;
}

interface BaseIndex {
	version: 1;
	entries: Record<string, StoredBase>;
}

const INDEX_VERSION = 1;
const MAX_ENTRIES = 2000;

export class MemoryBaseStore {
	private readonly dir: string;
	private readonly indexPath: string;
	private index: BaseIndex | undefined;

	constructor(dir: string) {
		this.dir = dir;
		this.indexPath = join(dir, "index.json");
	}

	private load(): BaseIndex {
		if (this.index) return this.index;
		const stored = readJsonFile<BaseIndex>(this.indexPath);
		this.index =
			stored && stored.version === INDEX_VERSION && stored.entries && typeof stored.entries === "object"
				? { version: INDEX_VERSION, entries: stored.entries }
				: { version: INDEX_VERSION, entries: {} };
		return this.index;
	}

	private save(): void {
		ensureDir(this.dir);
		writeJsonFile(this.indexPath, this.load());
	}

	get(key: string): { hash: string; text: string } | undefined {
		const entry = this.load().entries[key];
		if (!entry) return undefined;
		try {
			return { hash: entry.hash, text: readFileSync(join(this.dir, entry.file), "utf8") };
		} catch {
			delete this.load().entries[key];
			this.save();
			return undefined;
		}
	}

	set(key: string, text: string): void {
		const index = this.load();
		const bytes = Buffer.from(text, "utf8");
		const hash = sha256(new Uint8Array(bytes));
		if (index.entries[key]?.hash === hash) return;
		ensureDir(this.dir);
		const file = `${hash}.txt`;
		const target = join(this.dir, file);
		try {
			const temporary = join(this.dir, `${hash}.${process.pid}.tmp`);
			writeFileSync(temporary, bytes);
			renameSync(temporary, target);
		} catch {
			// A read-only agent directory must not stop the merge; the next pass simply has no base.
			return;
		}
		const previous = index.entries[key];
		if (previous && previous.file !== file) rmSync(join(this.dir, previous.file), { force: true });
		index.entries[key] = { hash, file, at: nowIso() };
		this.prune(index);
		this.save();
	}

	remove(key: string): void {
		const index = this.load();
		const entry = index.entries[key];
		if (!entry) return;
		delete index.entries[key];
		rmSync(join(this.dir, entry.file), { force: true });
		this.save();
	}

	private prune(index: BaseIndex): void {
		const entries = Object.entries(index.entries);
		if (entries.length <= MAX_ENTRIES) return;
		entries.sort((left, right) => left[1].at.localeCompare(right[1].at));
		for (const [key, entry] of entries.slice(0, entries.length - MAX_ENTRIES)) {
			delete index.entries[key];
			rmSync(join(this.dir, entry.file), { force: true });
		}
	}
}

/** Per-account directory so two Google accounts never share an ancestor. */
export function memoryBaseDir(syncDir: string, accountKey: string): string {
	return join(syncDir, `bases-${shortHash(accountKey)}`);
}
