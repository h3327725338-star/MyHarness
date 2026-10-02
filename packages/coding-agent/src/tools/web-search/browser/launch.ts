import type { ChildProcess } from "node:child_process";

/** The page as the browser shows it right now. `tabId` names the tab for later `read` / `close` commands. */
export interface PageSnapshot {
	tabId: number | string;
	url: string;
	title?: string;
	html: string;
	/** Whether the request's selector matched when the page was read. */
	ready: boolean;
	/** HTTP status of the tab's last top-level response (0 when unknown). */
	status: number;
}

/**
 * How MyHarness talks to a running browser, whatever the browser is: the Firefox extension's loopback bridge and the
 * Chromium DevTools pipe both answer the same `open` / `read` / `close` commands with a PageSnapshot.
 */
export interface PageBridge {
	command<T>(command: Record<string, unknown>, timeoutMs: number): Promise<T>;
	/** Reject everything that is still waiting (the browser is gone). */
	failAll(error: Error): void;
	/**
	 * Ask the browser to quit by itself, so it writes its cookies to disk first. Optional: a browser without it (or one
	 * that does not quit in time) is ended by its process.
	 */
	quit?(): Promise<void>;
	close(): void;
}

/** A browser process that was just started, and the step that waits until it takes commands. */
export interface BrowserLaunch {
	child: ChildProcess;
	bridge: PageBridge;
	ready: (options: { timeoutMs: number; signal?: AbortSignal; isAlive: () => boolean }) => Promise<void>;
}
