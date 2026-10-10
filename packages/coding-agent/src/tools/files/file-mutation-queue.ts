import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonicalFilePathKey } from "./read-state.ts";

/**
 * Queues by key. One mutation can hold several keys (see `getMutationQueueKeys`),
 * and each key keeps its own chain of waiting operations.
 */
const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

/**
 * Keys that identify "the same file" for serialisation purposes.
 *
 * `realpath` alone is not usable as the single key: it answers a question about
 * the filesystem, so the same path can produce two different keys depending on
 * whether the file exists yet. A write that creates a file and an edit of that
 * file a moment later then land on two keys and run in parallel against one
 * file, which is exactly what this queue exists to prevent.
 *
 * So every operation holds all of:
 * - `path:` the normalised absolute path. Never touches the filesystem, so it
 *   cannot drift, and it always covers two calls that name the file the same way.
 * - `parent:` the parent directory resolved through symlinks and junctions, plus
 *   the file name. Stable whether or not the file itself exists, so alias
 *   directories still collapse.
 * - `file:` the fully resolved file, when the file already resolves. This keeps
 *   symlink aliases of an existing file on one queue.
 *
 * Keys are acquired in sorted order, so concurrent operations can never hold one
 * key each and wait for the other.
 */
async function getMutationQueueKeys(filePath: string): Promise<string[]> {
	const resolvedPath = resolve(filePath);
	const keys = new Set<string>([`path:${canonicalFilePathKey(resolvedPath)}`]);

	// An unreadable parent or file only costs the alias collapsing, never the
	// serialisation of calls that name the file the same way.
	try {
		const parentRealPath = await realpath(dirname(resolvedPath));
		keys.add(`parent:${canonicalFilePathKey(`${parentRealPath}/${basename(resolvedPath)}`)}`);
	} catch {
		// The parent does not exist yet, or cannot be resolved.
	}

	try {
		keys.add(`file:${canonicalFilePathKey(await realpath(resolvedPath))}`);
	} catch {
		// The file does not exist yet, or cannot be resolved.
	}

	return [...keys].sort();
}

/**
 * Take one key's turn. Resolves once the operation may run, and returns the
 * function that hands the key to the next waiter.
 */
async function acquireMutationQueue(key: string): Promise<() => void> {
	const registration = registrationQueue.then(async () => {
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;

	return () => {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	};
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const keys = await getMutationQueueKeys(filePath);
	const releases: Array<() => void> = [];
	try {
		for (const key of keys) {
			releases.push(await acquireMutationQueue(key));
		}
		return await fn();
	} finally {
		for (const release of releases) release();
	}
}
