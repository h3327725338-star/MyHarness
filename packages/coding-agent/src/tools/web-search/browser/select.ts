import type { WebSearchBrowserId } from "../../../config/settings/types.ts";
import type {
	BrowserChallengeRequest,
	BrowserPageRequest,
	BrowserState,
	BrowserTransport,
	TransportPage,
} from "../transport.ts";
import { BROWSER_KINDS, BROWSER_LABELS, getSharedBrowser, type LocalBrowser } from "./firefox.ts";

/**
 * The browser the Web Search settings choose, as one transport: a named browser, or with "auto" the first installed
 * one of Firefox, Chrome and Edge. The choice is read on every call, so changing the setting applies to the next page.
 */
export class SelectedBrowser implements BrowserTransport {
	private readonly preference: () => WebSearchBrowserId;
	private readonly useDailyCookies: () => boolean;

	constructor(preference: () => WebSearchBrowserId, useDailyCookies: () => boolean = () => false) {
		this.preference = preference;
		this.useDailyCookies = useDailyCookies;
	}

	private pick(): LocalBrowser | undefined {
		const preference = this.preference();
		const browser =
			preference !== "auto"
				? getSharedBrowser(preference)
				: BROWSER_KINDS.map((kind) => getSharedBrowser(kind)).find((candidate) => candidate.state().available);
		// Applies when the browser next starts; a running one keeps the cookies it has.
		if (browser) browser.useDailyCookies = this.useDailyCookies();
		return browser;
	}

	state(): BrowserState {
		return (
			this.pick()?.state() ?? {
				available: false,
				reason: `没有找到可用的浏览器（${BROWSER_KINDS.map((kind) => BROWSER_LABELS[kind]).join("、")}）。安装其中任意一个后即可使用浏览器兜底。`,
			}
		);
	}

	private require(): LocalBrowser {
		// Callers check state() first; a browser that disappeared in between fails with its own clear reason on use.
		return this.pick() ?? getSharedBrowser("firefox");
	}

	load(request: BrowserPageRequest, signal?: AbortSignal): Promise<TransportPage> {
		return this.require().load(request, signal);
	}

	solveChallenge(request: BrowserChallengeRequest, signal?: AbortSignal): Promise<TransportPage> {
		return this.require().solveChallenge(request, signal);
	}
}
