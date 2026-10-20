/**
 * 同一仓库的 Git 写操作（add/commit/reset，含 pre-commit hook）在进程内串行。
 *
 * 多个对话共享同一个工作区时，两个提交同时跑会争抢 `.git/index.lock`，后到的一方
 * 直接失败；hook 还会重写文件，让另一方的提交上下文失效。这里让后到的提交排队等待，
 * 轮到它时再重新读取最新状态，而不是在冲突中失败或无响应。
 */

const tails = new Map<string, Promise<void>>();

function lockKey(repositoryRoot: string): string {
	const normalized = repositoryRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Runs `work` once every earlier write on the same repository has finished.
 * `onWait` fires only when this call really has to queue. A cancelled `signal` stops the wait
 * (and never runs `work`); it does not interrupt the holder.
 */
export async function withGitWriteLock<T>(
	repositoryRoot: string,
	work: () => Promise<T>,
	options: { signal?: AbortSignal; onWait?: () => void } = {},
): Promise<T> {
	const key = lockKey(repositoryRoot);
	const previous = tails.get(key);
	let release!: () => void;
	const mine = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = (previous ?? Promise.resolve()).then(() => mine);
	tails.set(key, tail);
	try {
		if (previous) {
			options.onWait?.();
			await waitFor(previous, options.signal);
		}
		options.signal?.throwIfAborted();
		return await work();
	} finally {
		release();
		if (tails.get(key) === tail) tails.delete(key);
	}
}

function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return promise;
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
		);
	});
}
