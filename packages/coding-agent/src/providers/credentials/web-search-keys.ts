import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

/** Web Search engines that need a user-supplied API key. */
export type WebSearchKeyEngine = "tavily";

/** Environment variables read when no key is stored for an engine. */
const ENVIRONMENT_FALLBACK: Record<WebSearchKeyEngine, string> = {
	tavily: "TAVILY_API_KEY",
};

/** One saved key. `key` never leaves the server. */
export interface StoredWebSearchKey {
	id: string;
	label: string;
	key: string;
}

/** What the settings page may see of a saved key. */
export interface WebSearchKeySummary {
	id: string;
	label: string;
	/** Last four characters, to tell keys apart. */
	suffix: string;
}

const MAX_LABEL_LENGTH = 60;

/**
 * Web Search API keys, kept apart from model provider credentials in their own
 * locked, owner-only file. Keys are never written to settings.json. An engine may
 * have several named keys; they are used in the order they were added.
 */
export class WebSearchApiKeys {
	private readonly storage: AuthStorageBackend;
	/** Set for the default file backend so reads never create the key file. */
	private readonly filePath: string | undefined;

	constructor(storage?: AuthStorageBackend) {
		if (storage) {
			this.storage = storage;
		} else {
			this.filePath = join(getAgentDir(), "web-search-keys.json");
			this.storage = new FileAuthStorageBackend(this.filePath);
		}
	}

	/** Every entry of the file, including ones for engines that no longer exist, so a write never drops them. */
	private parseRaw(text: string | undefined): Record<string, unknown> {
		try {
			const data = JSON.parse(text ?? "{}") as unknown;
			return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}

	/** The engine's saved keys; a single string (the first format) reads as one key. */
	private parseKeys(raw: Record<string, unknown>, engine: WebSearchKeyEngine): StoredWebSearchKey[] {
		const value = raw[engine];
		if (typeof value === "string") return value.trim() ? [{ id: "key-1", label: "Key 1", key: value.trim() }] : [];
		if (!Array.isArray(value)) return [];
		const keys: StoredWebSearchKey[] = [];
		for (const item of value as Array<Record<string, unknown>>) {
			if (!item || typeof item !== "object") continue;
			const key = typeof item.key === "string" ? item.key.trim() : "";
			const id = typeof item.id === "string" ? item.id : "";
			if (!key || !id || keys.some((k) => k.id === id)) continue;
			const label =
				typeof item.label === "string" && item.label.trim() ? item.label.trim() : `Key ${keys.length + 1}`;
			keys.push({ id, label, key });
		}
		return keys;
	}

	private readKeys(engine: WebSearchKeyEngine): StoredWebSearchKey[] {
		if (this.filePath && !existsSync(this.filePath)) return [];
		return this.storage.withLock((text) => ({ result: this.parseKeys(this.parseRaw(text), engine) }));
	}

	/** Change the engine's key list under the file lock; `change` returns its result. */
	private update<T>(engine: WebSearchKeyEngine, change: (keys: StoredWebSearchKey[]) => T): T {
		return this.storage.withLock((text) => {
			const raw = this.parseRaw(text);
			const keys = this.parseKeys(raw, engine);
			const result = change(keys);
			const next: Record<string, unknown> = { ...raw, [engine]: keys };
			if (!keys.length) delete next[engine];
			return { result, next: JSON.stringify(next, null, 2) };
		});
	}

	/** The saved keys in the order they are used. */
	listStored(engine: WebSearchKeyEngine): StoredWebSearchKey[] {
		return this.readKeys(engine);
	}

	/** The saved keys without their values, for the settings page. */
	summaries(engine: WebSearchKeyEngine): WebSearchKeySummary[] {
		return this.readKeys(engine).map(({ id, label, key }) => ({ id, label, suffix: key.slice(-4) }));
	}

	/** The keys to try, in order: the saved ones, or the engine's environment variable when none is saved. */
	all(engine: WebSearchKeyEngine): string[] {
		const stored = this.readKeys(engine).map((k) => k.key);
		if (stored.length) return stored;
		const fromEnvironment = process.env[ENVIRONMENT_FALLBACK[engine]]?.trim();
		return fromEnvironment ? [fromEnvironment] : [];
	}

	/** The first key to try, or undefined when there is none. */
	get(engine: WebSearchKeyEngine): string | undefined {
		return this.all(engine)[0];
	}

	/** Whether a key is saved in the key file (the environment fallback is not counted). */
	hasStored(engine: WebSearchKeyEngine): boolean {
		return this.readKeys(engine).length > 0;
	}

	/** Save a new key at the end of the list; returns its id. */
	add(engine: WebSearchKeyEngine, key: string, label?: string): string {
		const trimmed = key.trim();
		if (!trimmed) throw new Error("API Key 不能为空。");
		return this.update(engine, (keys) => {
			if (keys.some((k) => k.key === trimmed)) throw new Error("这个 API Key 已经保存过了。");
			const name = label?.trim().slice(0, MAX_LABEL_LENGTH) || `Key ${keys.length + 1}`;
			const id = randomUUID();
			keys.push({ id, label: name, key: trimmed });
			return id;
		});
	}

	rename(engine: WebSearchKeyEngine, id: string, label: string): void {
		const name = label.trim().slice(0, MAX_LABEL_LENGTH);
		if (!name) throw new Error("名称不能为空。");
		this.update(engine, (keys) => {
			const entry = keys.find((k) => k.id === id);
			if (!entry) throw new Error("找不到这个 API Key。");
			entry.label = name;
		});
	}

	remove(engine: WebSearchKeyEngine, id: string): void {
		this.update(engine, (keys) => {
			const index = keys.findIndex((k) => k.id === id);
			if (index < 0) throw new Error("找不到这个 API Key。");
			keys.splice(index, 1);
		});
	}

	/** Remove every saved key of the engine. */
	clear(engine: WebSearchKeyEngine): void {
		this.update(engine, (keys) => {
			keys.length = 0;
		});
	}

	static environmentVariable(engine: WebSearchKeyEngine): string {
		return ENVIRONMENT_FALLBACK[engine];
	}
}
