/**
 * Reconnect watchdog for the browser's EventSource.
 *
 * The browser retries a dropped event stream by itself, but it gives up permanently whenever the server answers a
 * (re)connect with a failure status or a wrong content type — then `readyState` becomes CLOSED and no retry ever
 * happens again, which is exactly the page state that shows "connection lost — reconnecting…" forever. This watchdog
 * rebuilds that stream, and bounds native retries stuck in CONNECTING when the caller supplies `isConnecting`.
 * Pure logic: the caller injects stream state / rebuild and the timer hooks, so it is testable outside a browser.
 */

/** EventSource.CLOSED (the value is fixed by the platform; there is no global to read in tests). */
export const EVENT_SOURCE_CLOSED = 2;

/** A stream that will never produce events again: missing or permanently failed. */
export function isDeadStream(source) {
	return source === null || source === undefined || source.readyState === EVENT_SOURCE_CLOSED;
}

export function createSseWatchdog({ isClosed, isConnecting = () => false, rebuild, delayMs = 3000, connectingDelayMs = 15_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
	let timer;
	return {
		/** Give native reconnect a bounded chance; CONNECTING is not proof it is making progress. */
		watch() {
			if ((!isClosed() && !isConnecting()) || timer !== undefined) return;
			timer = setTimeoutFn(() => {
				timer = undefined;
				// A reconnect may have opened in the meantime (e.g. the page re-created the stream).
				if (isClosed() || isConnecting()) rebuild();
			}, isClosed() ? delayMs : connectingDelayMs);
		},
		cancel() {
			if (timer === undefined) return;
			clearTimeoutFn(timer);
			timer = undefined;
		},
		/** The tab became visible again: rebuild at once instead of waiting (background timers are throttled). */
		revive() {
			this.cancel();
			if (isClosed() || isConnecting()) rebuild();
		},
	};
}
