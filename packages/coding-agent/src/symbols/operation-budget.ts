/** End-to-end budgets, not a fresh timeout for each nested LSP request. */
export class SymbolsTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(timeoutMs: number) {
		super(
			`symbols query exceeded its ${timeoutMs}ms budget; narrow the path or retry after the server has warmed up`,
		);
		this.name = "SymbolsTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export interface OperationBudget {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly remainingMs: () => number;
	readonly check: () => void;
	readonly timedOut: () => boolean;
	readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly dispose: () => void;
}

/** A hung dependency cannot keep the caller waiting after cancellation/deadline. */
export function createOperationBudget(timeoutMs: number, parent?: AbortSignal): OperationBudget {
	const controller = new AbortController();
	const deadline = Date.now() + timeoutMs;
	let expired = false;
	const onAbort = () =>
		controller.abort(parent?.reason ?? new DOMException("The operation was aborted", "AbortError"));
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const expire = () => {
		expired = true;
		controller.abort(new SymbolsTimeoutError(timeoutMs));
	};
	const timer = setTimeout(expire, timeoutMs);
	const check = () => {
		if (!controller.signal.aborted && Date.now() >= deadline) expire();
		controller.signal.throwIfAborted();
	};
	return {
		signal: controller.signal,
		timeoutMs,
		remainingMs: () => {
			check();
			return Math.max(1, deadline - Date.now());
		},
		check,
		timedOut: () => expired,
		async run<T>(operation: () => Promise<T>): Promise<T> {
			check();
			return new Promise<T>((resolve, reject) => {
				const aborted = () => {
					controller.signal.removeEventListener("abort", aborted);
					reject(controller.signal.reason);
				};
				controller.signal.addEventListener("abort", aborted, { once: true });
				Promise.resolve()
					.then(() => {
						controller.signal.throwIfAborted();
						return operation();
					})
					.then((value) => {
						check();
						return value;
					})
					.then(resolve, reject)
					.finally(() => controller.signal.removeEventListener("abort", aborted));
			});
		},
		dispose() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}
