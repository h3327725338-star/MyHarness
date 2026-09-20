import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { writeFileAtomicallySync } from "../../utils/atomic-write.ts";
import { getSettingsFilePaths } from "../paths/index.ts";
import type { SettingsScope } from "./types.ts";

export interface SettingsStorage {
	/**
	 * Run `fn` against the current serialized settings for `scope`. Returning
	 * `undefined` means "no write": that path never takes the file lock or
	 * creates directories for a missing file. Returning a string commits an
	 * atomic write.
	 *
	 * When the file already exists `fn` is invoked exactly once, under the lock.
	 * When the file is absent, `fn` is first probed without a lock; if it requests
	 * a write and a concurrent writer has since created the file, `fn` is invoked
	 * once more with that content. Write callbacks must therefore be pure functions
	 * of their input (the shipped write callback only merges the passed content).
	 */
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

/** File-backed Settings storage preserving the existing lock and atomic-write protocol. */
export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const paths = getSettingsFilePaths(cwd, agentDir, CONFIG_DIR_NAME);
		this.globalSettingsPath = paths.global;
		this.projectSettingsPath = paths.project;
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;

		// Existing file: keep the previous semantics and run the whole read-modify-write
		// (including the read) while holding the lock, so concurrent writers serialize
		// and no callback is invoked twice.
		if (existsSync(path)) {
			const release = this.acquireLockSyncWithRetry(path);
			try {
				const current = readFileSync(path, "utf-8");
				const next = fn(current);
				if (next !== undefined) {
					writeFileAtomicallySync(path, next);
				}
			} finally {
				release();
			}
			return;
		}

		// File is absent. Probe without creating directories so read-only callers stay
		// side-effect free and are invoked exactly once.
		const probe = fn(undefined);
		if (probe === undefined) {
			return;
		}

		// A write is required. Take the lock and, if another writer created the file
		// since the probe, recompute against that content instead of clobbering it.
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const release = this.acquireLockSyncWithRetry(path);
		try {
			const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			const next = current === undefined ? probe : fn(current);
			if (next !== undefined) {
				writeFileAtomicallySync(path, next);
			}
		} finally {
			release();
		}
	}
}

/** In-memory storage used by tests and callers that need the Settings API without file I/O. */
export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}
