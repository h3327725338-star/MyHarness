import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../../utils/atomic-write.ts";

interface CacheRecord<T> {
	savedAt: number;
	value: T;
}

/** In-memory entries kept per cache instance; older entries are still readable from disk. */
const MAX_MEMORY_ENTRIES = 256;
/** Disk entries older than this are removed during an occasional sweep. */
const MAX_DISK_AGE_MS = 24 * 60 * 60 * 1_000;
const DISK_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** A small session-scoped cache. Without a persisted session it stays in memory. */
export class WebSearchCache {
	private readonly memory = new Map<string, CacheRecord<unknown>>();
	private readonly rootDir: string | undefined;
	private readonly now: () => number;
	private lastDiskSweepAt: number | undefined;

	constructor(rootDir: string | undefined, now: () => number = Date.now) {
		this.rootDir = rootDir;
		this.now = now;
	}

	private path(namespace: string, key: string): string | undefined {
		if (!this.rootDir) return undefined;
		return join(this.rootDir, namespace, `${key}.json`);
	}

	private remember(cacheKey: string, record: CacheRecord<unknown>): void {
		// Re-insert so Map iteration order doubles as least-recently-used order.
		this.memory.delete(cacheKey);
		this.memory.set(cacheKey, record);
		while (this.memory.size > MAX_MEMORY_ENTRIES) {
			const oldest = this.memory.keys().next().value;
			if (oldest === undefined) break;
			this.memory.delete(oldest);
		}
	}

	async get<T>(namespace: string, key: string, ttlMs: number, bypass = false): Promise<T | undefined> {
		if (bypass) return undefined;
		const cacheKey = `${namespace}:${key}`;
		let record = this.memory.get(cacheKey) as CacheRecord<T> | undefined;
		if (!record) {
			const filePath = this.path(namespace, key);
			if (filePath) {
				try {
					record = JSON.parse(await readFile(filePath, "utf8")) as CacheRecord<T>;
				} catch {
					return undefined;
				}
			}
		}
		if (!record || !Number.isFinite(record.savedAt) || this.now() - record.savedAt > ttlMs) {
			this.memory.delete(cacheKey);
			return undefined;
		}
		this.remember(cacheKey, record);
		return record.value;
	}

	/**
	 * Store a value. The disk copy is best effort: a cache that cannot be written
	 * must not turn an already successful search or fetch into a failure.
	 */
	async set<T>(namespace: string, key: string, value: T): Promise<void> {
		const record: CacheRecord<T> = { savedAt: this.now(), value };
		this.remember(`${namespace}:${key}`, record);
		const filePath = this.path(namespace, key);
		if (!filePath) return;
		try {
			await mkdir(join(this.rootDir!, namespace), { recursive: true });
			await writeFileAtomically(filePath, JSON.stringify(record));
		} catch {
			return;
		}
		await this.sweepDisk(namespace);
	}

	private async sweepDisk(namespace: string): Promise<void> {
		const now = this.now();
		if (this.lastDiskSweepAt !== undefined && now - this.lastDiskSweepAt < DISK_SWEEP_INTERVAL_MS) return;
		this.lastDiskSweepAt = now;
		const dir = join(this.rootDir!, namespace);
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const filePath = join(dir, name);
			try {
				const info = await stat(filePath);
				if (info.isFile() && now - info.mtimeMs > MAX_DISK_AGE_MS) await rm(filePath, { force: true });
			} catch {
				// Another process may have removed or replaced the entry; the next sweep retries.
			}
		}
	}
}
