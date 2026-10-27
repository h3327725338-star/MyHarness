import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
	 * When the file already exists `fn` is invoked exactly once, under the lock;
	 * a call that writes nothing may read without the lock while another writer
	 * holds it, since writers replace the file whole. When the file is absent,
	 * `fn` is first probed without a lock; if it requests
	 * a write and a concurrent writer has since created the file, `fn` is invoked
	 * once more with that content. Write callbacks must therefore be pure functions
	 * of their input (the shipped write callback only merges the passed content).
	 */
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	withLockAsync?(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void>;
}

/*
 * Every chat of a Web UI server has its own SettingsManager on the same settings files, so most contention for a
 * file's lock comes from inside one process. This process's own writes of a file take turns before they try the lock
 * (`turns`), and while one of them is replacing the file a synchronous read here uses the content it is replacing
 * (`replacing`): the file can be missing for a moment while it is replaced on Windows (see replaceFile in
 * utils/atomic-write.ts), and the lock stays taken until the write is done.
 */
const turns = new Map<string, Promise<void>>();
const replacing = new Map<string, string | undefined>();

function fileKey(path: string): string {
	const normalized = resolve(path).replace(/\\/gu, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Runs `work` once every earlier write of this process to the same file has finished. */
async function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = turns.get(key) ?? Promise.resolve();
	let done!: () => void;
	const mine = new Promise<void>((resolveTurn) => {
		done = resolveTurn;
	});
	const tail = previous.then(() => mine);
	turns.set(key, tail);
	try {
		await previous;
		return await work();
	} finally {
		done();
		if (turns.get(key) === tail) turns.delete(key);
	}
}

function lockHeldError(path: string): Error {
	return Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: path });
}

/** File-backed Settings storage preserving the existing lock and atomic-write protocol. */
/**
 * The settings lock is held only for one short read-modify-write. If its directory disappears meanwhile (the
 * data root was removed or moved), proper-lockfile's default handler throws an unhandled error from a timer;
 * the write itself already succeeded or failed on its own, so there is nothing left to act on.
 */
function ignoreCompromisedSettingsLock(): void {}

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
		return lockfile.lockSync(path, { realpath: false, onCompromised: ignoreCompromisedSettingsLock });
	}

	async withLockAsync(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void> {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const key = fileKey(path);
		const read = async () => {
			try {
				return await readFile(path, "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		};
		await inTurn(key, async () => {
			const initial = await read();
			let probe: string | undefined;
			if (initial === undefined) {
				probe = fn(undefined);
				if (probe === undefined) return;
				await mkdir(dirname(path), { recursive: true });
			}
			const release = await lockfile.lock(path, {
				realpath: false,
				onCompromised: ignoreCompromisedSettingsLock,
				// Only another process can hold the lock here, for one short read and write. Waiting longer than
				// proper-lockfile's 10-second stale limit takes over a lock left behind by a process that died.
				retries: { retries: 12, factor: 2, minTimeout: 20, maxTimeout: 2_000 },
			});
			try {
				const current = await read();
				const next = current === undefined && initial === undefined ? probe : fn(current);
				if (next === undefined) return;
				replacing.set(key, current);
				try {
					await writeFileAtomically(path, next);
				} finally {
					replacing.delete(key);
				}
			} finally {
				await release();
			}
		});
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const key = fileKey(path);

		// A write of this process is replacing the file: read what it replaces. Writing has to wait for it.
		if (replacing.has(key)) {
			if (fn(replacing.get(key)) !== undefined) throw lockHeldError(path);
			return;
		}

		// Existing file: keep the previous semantics and run the whole read-modify-write
		// (including the read) while holding the lock, so concurrent writers serialize
		// and no callback is invoked twice.
		if (existsSync(path)) {
			let release: () => void;
			try {
				release = this.acquireLockSyncWithRetry(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
				// Another writer holds the lock. It replaces the file whole, so a call that writes nothing reads it
				// without the lock; a file missing right now is being replaced, not absent.
				let current: string;
				try {
					current = readFileSync(path, "utf-8");
				} catch {
					throw error;
				}
				if (fn(current) !== undefined) throw error;
				return;
			}
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
