/**
 * Reconnect watchdog for the browser's EventSource.
 *
 * The browser retries a dropped event stream by itself, but it gives up permanently whenever the server answers a
 * (re)connect with a failure status or a wrong content type — then `readyState` becomes CLOSED and no retry ever
 * happens again, which is exactly the page state that shows "connection lost — reconnecting…" forever. This watchdog
 * notices such a dead stream and asks for a brand-new EventSource, so reconnecting stays automatic in every case.
 * Pure logic: the caller injects `isClosed` / `rebuild` and the timer hooks, so it is testable outside a browser.
 */

/** EventSource.CLOSED (the value is fixed by the platform; there is no global to read in tests). */
export const EVENT_SOURCE_CLOSED = 2;

/** A stream that will never produce events again: missing or permanently failed. */
export function isDeadStream(source) {
	return source === null || source === undefined || source.readyState === EVENT_SOURCE_CLOSED;
}

export function createSseWatchdog({ isClosed, rebuild, delayMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
	let timer;
	return {
		/** Called when the stream errors: only a permanently closed one gets a rebuild scheduled. */
		watch() {
			if (!isClosed() || timer !== undefined) return;
			timer = setTimeoutFn(() => {
				timer = undefined;
				// A reconnect may have opened in the meantime (e.g. the page re-created the stream).
				if (isClosed()) rebuild();
			}, delayMs);
		},
		cancel() {
			if (timer === undefined) return;
			clearTimeoutFn(timer);
			timer = undefined;
		},
		/** The tab became visible again: rebuild at once instead of waiting (background timers are throttled). */
		revive() {
			this.cancel();
			if (isClosed()) rebuild();
		},
	};
}
