// Only reads may be replayed: a failed write may already have changed server state.
// Keep one deadline across retries, including response-body consumption.
export async function readResponse(fetchFn, path, init, { timeoutMs, retryReads = true, retryDelayMs = 150 } = {}) {
	const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : init.signal;
	const request = { ...init, ...(signal ? { signal } : {}) };
	const retryable = retryReads && (request.method === "GET" || request.method === "HEAD");
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetchFn(path, request);
			const text = await response.text();
			return { response, text };
		} catch (error) {
			if (!retryable || attempt >= 2 || signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError" || !(error instanceof TypeError)) throw error;
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
			signal?.throwIfAborted();
		}
	}
}
