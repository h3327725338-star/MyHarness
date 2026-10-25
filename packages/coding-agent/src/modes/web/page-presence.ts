import type { WebHttpServer } from "./http-server.ts";

/** A page that stopped reporting (crashed, closed without saying so) no longer counts after this long. */
const PRESENCE_TTL_MS = 3 * 60 * 1000;

interface PageReport {
	slot: string;
	focused: boolean;
	at: number;
}

/**
 * Which chat each open page shows and whether its window has the focus, as the pages report it. The task-end popup the
 * service shows itself (when no page answered in time, e.g. a page busy rendering) uses it: a chat the user is looking
 * at gets no popup, the same rule the page applies to its own notifications.
 */
export class PagePresence {
	private readonly pages = new Map<string, PageReport>();

	report(page: string, slot: string, focused: boolean, now = Date.now()): void {
		this.pages.set(page, { slot, focused, at: now });
	}

	drop(page: string): void {
		this.pages.delete(page);
	}

	/**
	 * Whether a focused page shows `slot` ("always": only that chat is skipped), or any page of the app is focused
	 * ("unfocused": notifications only while the app is in the background).
	 */
	watching(slot: string, focus: "always" | "unfocused" | string, now = Date.now()): boolean {
		for (const [page, report] of this.pages) {
			if (now - report.at > PRESENCE_TTL_MS) {
				this.pages.delete(page);
				continue;
			}
			if (report.focused && (focus === "unfocused" || report.slot === slot)) return true;
		}
		return false;
	}
}

const registry = new WeakMap<WebHttpServer, PagePresence>();

/** One presence record per server: every slot of the process shares the pages. */
export function pagePresence(server: WebHttpServer): PagePresence {
	let presence = registry.get(server);
	if (!presence) {
		presence = new PagePresence();
		registry.set(server, presence);
	}
	return presence;
}
