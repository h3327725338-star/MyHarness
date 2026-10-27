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

/** One operation's place in one key's chain. */
interface MutationSlot {
	/** Settles when every earlier holder of this key has released it. */
	currentQueue: Promise<void>;
	/** Hands the key to the next waiter; safe to call more than once. */
	release: () => void;
}

/** Join the end of one key's chain. Synchronous, so slots are taken exactly in the order this is called. */
function registerMutationSlot(key: string): MutationSlot {
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);
	return {
		currentQueue,
		release: () => {
			releaseNext();
			if (fileMutationQueues.get(key) === chainedQueue) {
				fileMutationQueues.delete(key);
			}
		},
	};
}

/**
 * Wait for one slot's turn.
 *
 * When `signal` aborts while waiting, the waiter releases its registered slot
 * (so the chain behind it never stalls) and throws `Operation aborted`. This
 * only applies before the operation starts: once acquired, the running
 * operation keeps the queue locked until it settles and observes aborts itself.
 */
async function waitForMutationTurn(slot: MutationSlot, signal?: AbortSignal): Promise<void> {
	const { currentQueue, release } = slot;
	if (signal?.aborted) {
		release();
		throw new Error("Operation aborted");
	}
	if (signal) {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				// Release the slot we registered before throwing, or every
				// waiter chained behind us would hang forever.
				release();
				reject(new Error("Operation aborted"));
			};
			currentQueue.then(
				() => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				// The queue chain only resolves; a rejection here is unreachable,
				// but handle it so a wait is never stuck.
				() => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
			);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		return;
	}

	await currentQueue;
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * When `signal` is given and aborts while waiting for the queue, the wait
 * throws `Operation aborted` promptly instead of holding the tool past the
 * abort grace period. Keys acquired before the abort are released as usual.
 */
export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	// The keys are resolved at once, alongside other calls, but the queues are joined in call order: an edit issued
	// after a write of the same file runs after it even when the edit's realpath lookups finish first. All of a call's
	// keys are joined in one step, so for any two operations the earlier one is ahead on every key they share.
	const keysReady = getMutationQueueKeys(filePath);
	const registration = registrationQueue.then(async () => (await keysReady).map(registerMutationSlot));
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);
	const slots = await registration;
	try {
		for (const slot of slots) await waitForMutationTurn(slot, signal);
		return await fn();
	} finally {
		for (const slot of slots) slot.release();
	}
}
