import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { writeFileAtomically, writeFileAtomicallySync } from "../../utils/atomic-write.ts";
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
	withLockAsync?(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void>;
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
		// The legacy synchronous entry must fail promptly rather than spin on the event loop.
		// Runtime saves use withLockAsync below, which retries without blocking.
		return lockfile.lockSync(path, { realpath: false });
	}

	async withLockAsync(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void> {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const read = async () => {
			try {
				return await readFile(path, "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		};
		const initial = await read();
		let probe: string | undefined;
		if (initial === undefined) {
			probe = fn(undefined);
			if (probe === undefined) return;
			await mkdir(dirname(path), { recursive: true });
		}
		const release = await lockfile.lock(path, {
			realpath: false,
			retries: { retries: 9, factor: 1, minTimeout: 20, maxTimeout: 20 },
		});
		try {
			const current = await read();
			const next = current === undefined && initial === undefined ? probe : fn(current);
			if (next !== undefined) await writeFileAtomically(path, next);
		} finally {
			await release();
		}
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
