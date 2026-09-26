import { existsSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

/** Web Search engines that need a user-supplied API key. */
export type WebSearchKeyEngine = "brave_api";

/** Environment variables read when no key is stored for an engine. */
const ENVIRONMENT_FALLBACK: Record<WebSearchKeyEngine, string> = {
	brave_api: "BRAVE_SEARCH_API_KEY",
};

type KeyData = Partial<Record<WebSearchKeyEngine, string>>;

/**
 * Web Search API keys, kept apart from model provider credentials in their own
 * locked, owner-only file. Keys are never written to settings.json.
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

	private readStored(): KeyData {
		if (this.filePath && !existsSync(this.filePath)) return {};
		return this.storage.withLock((text) => ({ result: this.parse(text) }));
	}

	private parse(text: string | undefined): KeyData {
		try {
			const data = JSON.parse(text ?? "{}") as unknown;
			if (!data || typeof data !== "object" || Array.isArray(data)) return {};
			const key = (data as Record<string, unknown>).brave_api;
			return typeof key === "string" && key.trim() ? { brave_api: key.trim() } : {};
		} catch {
			return {};
		}
	}

	/** The stored key, or the engine's environment variable when nothing is stored. */
	get(engine: WebSearchKeyEngine): string | undefined {
		const stored = this.readStored()[engine];
		return stored ?? (process.env[ENVIRONMENT_FALLBACK[engine]]?.trim() || undefined);
	}

	/** Whether a key is stored in the key file (the environment fallback is not counted). */
	hasStored(engine: WebSearchKeyEngine): boolean {
		return this.readStored()[engine] !== undefined;
	}

	set(engine: WebSearchKeyEngine, key: string): void {
		const trimmed = key.trim();
		if (!trimmed) throw new Error("API Key 不能为空。");
		this.storage.withLock((text) => {
			const next = { ...this.parse(text), [engine]: trimmed };
			return { result: undefined, next: JSON.stringify(next, null, 2) };
		});
	}

	clear(engine: WebSearchKeyEngine): void {
		this.storage.withLock((text) => {
			const next = this.parse(text);
			delete next[engine];
			return { result: undefined, next: JSON.stringify(next, null, 2) };
		});
	}

	static environmentVariable(engine: WebSearchKeyEngine): string {
		return ENVIRONMENT_FALLBACK[engine];
	}
}
