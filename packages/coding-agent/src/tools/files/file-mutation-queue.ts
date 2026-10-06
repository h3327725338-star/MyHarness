import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * The real location of a path that may not exist yet: the nearest existing ancestor is resolved
 * (links, junctions, short names) and the missing remainder is appended, so a file that is about to be
 * created is queued under the same key from whichever spelling of its directory it is reached.
 */
async function canonicalLocation(resolvedPath: string): Promise<string> {
	const missing: string[] = [];
	let current = resolvedPath;
	for (;;) {
		try {
			const real = await realpath(current);
			return missing.length === 0 ? real : join(real, ...missing.reverse());
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missing.push(basename(current));
			current = parent;
		}
	}
}

/**
 * The identity two spellings of one file share. Windows file names are compared without case, and a
 * hard link has several paths but one file index: both collapse to one key, so the queue and the
 * cross-process locks built on it cannot be bypassed by an alias.
 */
export async function getMutationQueueKey(filePath: string): Promise<string> {
	const location = await canonicalLocation(resolve(filePath));
	const key = process.platform === "win32" ? location.toLowerCase() : location;
	try {
		const info = await stat(location, { bigint: true });
		if (info.isFile() && info.nlink > 1n) return `link:${info.dev}:${info.ino}`;
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
	}
	return key;
}

export interface FileMutationQueueOptions {
	/** Abandons the wait for earlier operations; once `fn` has started it is not interrupted. */
	readonly signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function waitForPredecessors(held: readonly QueueRegistration[], signal: AbortSignal | undefined): Promise<void> {
	const settled = Promise.all(held.map((entry) => entry.currentQueue));
	if (!signal) {
		await settled;
		return;
	}
	if (signal.aborted) throw abortReason(signal);
	let onAbort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([settled, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

interface QueueRegistration {
	readonly key: string;
	readonly currentQueue: Promise<void>;
	readonly chainedQueue: Promise<void>;
	readonly releaseNext: () => void;
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
	options?: FileMutationQueueOptions,
): Promise<T> {
	return withFileMutationQueues([filePath], fn, options);
}

/**
 * Hold the queues of several files at once. All keys are registered in one step and in a fixed
 * order, so two batches over overlapping files cannot wait on each other, and a batch never starts
 * while any one of its files is still being changed by an earlier operation.
 *
 * The queue is not re-entrant: `fn` must not call `withFileMutationQueue` for a path it holds.
 */
export async function withFileMutationQueues<T>(
	filePaths: readonly string[],
	fn: () => Promise<T>,
	options?: FileMutationQueueOptions,
): Promise<T> {
	const registration = registrationQueue.then(async (): Promise<QueueRegistration[]> => {
		const keys = [...new Set(await Promise.all(filePaths.map(getMutationQueueKey)))].sort();
		return keys.map((key) => {
			const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

			let releaseNext!: () => void;
			const nextQueue = new Promise<void>((resolveQueue) => {
				releaseNext = resolveQueue;
			});
			const chainedQueue = currentQueue.then(() => nextQueue);
			fileMutationQueues.set(key, chainedQueue);

			return { key, currentQueue, chainedQueue, releaseNext };
		});
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const held = await registration;
	let waited = false;
	try {
		await waitForPredecessors(held, options?.signal);
		waited = true;
		return await fn();
	} finally {
		for (const { key, chainedQueue, releaseNext } of held) {
			releaseNext();
			const forget = (): void => {
				if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
			};
			// An abandoned wait leaves earlier operations running: later ones must still queue behind them.
			if (waited) forget();
			else void chainedQueue.then(forget, forget);
		}
	}
}
