import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../../utils/atomic-write.ts";

interface CacheRecord<T> {
	savedAt: number;
	value: T;
}

/** A small session-scoped cache. Without a persisted session it stays in memory. */
export class WebSearchCache {
	private readonly memory = new Map<string, CacheRecord<unknown>>();
	private readonly rootDir: string | undefined;
	private readonly now: () => number;

	constructor(rootDir: string | undefined, now: () => number = Date.now) {
		this.rootDir = rootDir;
		this.now = now;
	}

	private path(namespace: string, key: string): string | undefined {
		if (!this.rootDir) return undefined;
		return join(this.rootDir, namespace, `${key}.json`);
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
					this.memory.set(cacheKey, record);
				} catch {
					return undefined;
				}
			}
		}
		if (!record || !Number.isFinite(record.savedAt) || this.now() - record.savedAt > ttlMs) return undefined;
		return record.value;
	}

	async set<T>(namespace: string, key: string, value: T): Promise<void> {
		const record: CacheRecord<T> = { savedAt: this.now(), value };
		this.memory.set(`${namespace}:${key}`, record);
		const filePath = this.path(namespace, key);
		if (!filePath) return;
		await mkdir(join(this.rootDir!, namespace), { recursive: true });
		await writeFileAtomically(filePath, JSON.stringify(record));
	}
}
