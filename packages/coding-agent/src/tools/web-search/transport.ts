import { WebSearchError } from "./errors.ts";
import { decodeBody, type FetchLike, requestBytes } from "./http.ts";

/**
 * A search results page as a transport delivered it. Engines only see this
 * shape, whether the page came from a plain HTTP request or from Firefox.
 */
export interface TransportPage {
	status: number;
	/** Final URL after redirects (the browser follows them; HTTP does not). */
	url: string;
	text: string;
	headers: Headers;
	via: "http" | "browser";
	/** Browser only: whether the engine's results selector matched when the page was read. */
	ready?: boolean;
}

export interface HttpGetOptions {
	headers?: Record<string, string>;
	ipFamily?: 4;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
	/** Human-readable target used in diagnostics, e.g. "Google". */
	label: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Lightweight transport: one plain HTTP request, no redirects followed, no
 * JavaScript. Timeout, cancellation and body limits come from requestBytes.
 */
export class HttpTransport {
	private readonly fetchImpl: FetchLike;

	constructor(fetchImpl: FetchLike) {
		this.fetchImpl = fetchImpl;
	}

	async get(url: string, options: HttpGetOptions): Promise<TransportPage> {
		const response = await requestBytes(
			this.fetchImpl,
			url,
			{ method: "GET", headers: options.headers, ipFamily: options.ipFamily },
			{
				signal: options.signal,
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
				label: options.label,
			},
		);
		return {
			status: response.status,
			url,
			text: decodeBody(response.bytes, response.headers.get("content-type")),
			headers: response.headers,
			via: "http",
		};
	}

	/** Where a redirect URL points, without following it. Undefined when it is not a redirect. */
	async redirectTarget(url: string, options: HttpGetOptions): Promise<string | undefined> {
		const page = await this.get(url, { ...options, maxBytes: 64 * 1024 });
		const location = page.headers.get("location");
		if (page.status < 300 || page.status >= 400 || !location) return undefined;
		try {
			return new URL(location, url).toString();
		} catch {
			return undefined;
		}
	}
}

/** What the real-browser transport should load and when the page counts as loaded. */
export interface BrowserPageRequest {
	url: string;
	/** CSS selector that exists once the results are on the page. */
	readySelector: string;
	/** Engine name for messages, e.g. "Google". */
	label: string;
}

export interface BrowserChallengeRequest extends BrowserPageRequest {
	/** True once the page shows results instead of the challenge. */
	isSolved: (page: TransportPage) => boolean;
}

export type BrowserState = { available: true; executable: string } | { available: false; reason: string };

/** Real-browser transport. Implemented by FirefoxBrowser; tests use fakes. */
export interface BrowserTransport {
	/** Whether a browser can be used at all (installed, not disabled). Cheap; no launch. */
	state(): BrowserState;
	/** Load one page in the background browser and return its final DOM. */
	load(request: BrowserPageRequest, signal?: AbortSignal): Promise<TransportPage>;
	/**
	 * Show the page in a visible browser window so the user can pass a
	 * CAPTCHA/consent step; resolves with the page once `isSolved` holds.
	 */
	solveChallenge(request: BrowserChallengeRequest, signal?: AbortSignal): Promise<TransportPage>;
}

export function browserUnavailable(reason: string): WebSearchError {
	return new WebSearchError("browser_unavailable", reason);
}
