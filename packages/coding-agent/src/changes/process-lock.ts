/**
 * Cross-process locks for file changes.
 *
 * The in-process queue (tools/files/file-mutation-queue.ts) orders the sessions of one process. Another
 * MyHarness process (a second Web host, a delegated worker) is excluded by a lock directory per file identity
 * below the workspace's change-control root. Locks are always taken in one global order (sorted keys), so two
 * processes that need overlapping files cannot wait on each other forever; a holder that dies is replaced once
 * its lock goes stale.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ChangeControlError } from "./errors.ts";

export interface ProcessLockOptions {
	/** Directory that holds the lock directories. */
	readonly lockRoot: string;
	/** How long to wait for another process before giving up. */
	readonly timeoutMs?: number;
	/** A lock whose owner stopped refreshing it this long ago is taken over. */
	readonly staleMs?: number;
	/** Stops waiting for a busy lock; locks already taken are released. */
	readonly signal?: AbortSignal;
}

export interface HeldLocks {
	/** Set when a lock was lost while held (its directory vanished or could not be refreshed). */
	readonly compromised: () => Error | undefined;
	release(): Promise<void>;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
export const DEFAULT_LOCK_STALE_MS = 10_000;

function lockPathFor(lockRoot: string, key: string): string {
	return join(lockRoot, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.lock`);
}

/** Take the locks of all keys, or none: a lock that stays busy releases the ones already held. */
export async function acquireProcessLocks(keys: readonly string[], options: ProcessLockOptions): Promise<HeldLocks> {
	mkdirSync(options.lockRoot, { recursive: true });
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const stale = Math.max(2_000, options.staleMs ?? DEFAULT_LOCK_STALE_MS);
	const sorted = [...new Set(keys)].sort();
	const releases: Array<() => Promise<void>> = [];
	let compromised: Error | undefined;
	const deadline = Date.now() + timeoutMs;

	const releaseAll = async (): Promise<void> => {
		for (const release of releases.splice(0).reverse()) {
			try {
				await release();
			} catch {
				// The lock was already lost or removed; there is nothing left to release.
			}
		}
	};

	const cancelled = async (): Promise<never> => {
		await releaseAll();
		throw new ChangeControlError("CANCELLED", "cancelled while waiting for the files to be free");
	};

	for (const key of sorted) {
		const lockfilePath = lockPathFor(options.lockRoot, key);
		for (;;) {
			if (options.signal?.aborted) await cancelled();
			try {
				const release = await lockfile.lock(lockfilePath, {
					lockfilePath,
					realpath: false,
					stale,
					update: Math.floor(stale / 2),
					retries: 0,
					onCompromised: (error) => {
						compromised = error;
					},
				});
				releases.push(release);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
					await releaseAll();
					throw error;
				}
				if (Date.now() >= deadline) {
					await releaseAll();
					throw new ChangeControlError(
						"LOCK_TIMEOUT",
						"another MyHarness process is changing the same files; try again when it has finished",
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 60)));
			}
		}
	}
	return { compromised: () => compromised, release: releaseAll };
}
