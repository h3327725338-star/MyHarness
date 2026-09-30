/**
 * Web UI server lifetime. The server exits once the last browser page has been
 * disconnected for the grace period; a page that reconnects in time (reload,
 * F5, a quickly reopened tab) cancels the countdown. The connection count comes
 * from the real SSE connections, so a crashed or force-closed browser is
 * noticed too, without relying on a page-side "closing" event.
 *
 * The countdown only starts after a page has connected at least once: a server
 * started with `--no-open` keeps waiting for its first page.
 */

export interface WebLifecycleOptions {
	/** Grace period in seconds; read again for every countdown so a settings change applies to the next one. */
	getGraceSeconds: () => number;
	/** Called once when the grace period ends with no page connected. */
	onExpire: () => void;
	/** Timer hooks, overridable for tests. */
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export class WebLifecycle {
	private timer: unknown;
	private seenClient = false;
	private expired = false;

	private readonly options: WebLifecycleOptions;

	constructor(options: WebLifecycleOptions) {
		this.options = options;
	}

	/** Catch up with pages that connected (and maybe left) before this lifecycle was attached. */
	attach(count: number, everConnected: boolean): void {
		if (everConnected) this.seenClient = true;
		this.clientCountChanged(count);
	}

	/** Feed the current number of connected pages after every change. */
	clientCountChanged(count: number): void {
		if (this.expired) return;
		if (count > 0) {
			this.seenClient = true;
			this.cancel();
			return;
		}
		if (!this.seenClient) return;
		this.cancel();
		const delayMs = Math.max(0, this.options.getGraceSeconds()) * 1000;
		const start = this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.timer = start(() => {
			this.timer = undefined;
			this.expired = true;
			this.options.onExpire();
		}, delayMs);
	}

	/** Stop any pending countdown (called when the server shuts down for another reason). */
	dispose(): void {
		this.cancel();
		this.expired = true;
	}

	private cancel(): void {
		if (this.timer === undefined) return;
		(this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.timer);
		this.timer = undefined;
	}
}
