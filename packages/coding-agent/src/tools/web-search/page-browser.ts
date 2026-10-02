import { WebSearchError } from "./errors.ts";
import {
	type AccessWall,
	detectAccessWall,
	htmlToMarkdown,
	PAGE_LIMITS,
	type ReadPageResult,
	wallError,
} from "./page.ts";
import { type BrowserTransport, browserLabel, type TransportPage } from "./transport.ts";
import { checkResolvedHost, type HostLookup, validatePublicHttpUrl } from "./url.ts";

/** After a person did not get a site's page through, the window is not opened again for that site for this long. */
const DECLINED_COOLDOWN_MS = 2 * 60_000;

export interface BrowserPageReaderOptions {
	browser: BrowserTransport;
	lookup: HostLookup;
	now: () => number;
	/** True when a person is present who can be asked to pass a check or log in in a visible browser window. */
	interactive: () => boolean;
}

/**
 * Reads a page in the real browser when the plain request was refused (403, robot check, login, a page that needs
 * JavaScript). The browser keeps its cookies, so a check passed or a login made once is reused afterwards.
 *
 * When the page is a wall in the browser too and a person is present, the page is shown in a visible window and the
 * reader waits for the person to get through; the page that appears then is read, without starting the task again.
 * Whatever stays in the way is reported with what the site asked for, never as a bare status code.
 */
export class BrowserPageReader {
	private readonly options: BrowserPageReaderOptions;
	private readonly declined = new Map<string, { until: number; message: string }>();

	constructor(options: BrowserPageReaderOptions) {
		this.options = options;
	}

	async read(
		url: string,
		signal: AbortSignal | undefined,
		onProgress: ((message: string) => void) | undefined,
	): Promise<ReadPageResult> {
		const { browser } = this.options;
		const label = browserLabel(browser);
		/** E.g. why the daily browser's cookies could not be imported: part of why a login is still asked for. */
		const note = () => {
			const state = browser.state();
			return state.available && state.note ? `（${state.note}）` : "";
		};
		const hostname = new URL(url).hostname;
		const request = { url, readySelector: "", label: hostname };
		const wallOf = (page: TransportPage): AccessWall | undefined =>
			detectAccessWall(page.text, page.status, page.url);

		let page = await browser.load(request, signal);
		const wall = wallOf(page);
		if (wall) {
			if (!this.options.interactive()) {
				throw new WebSearchError(
					"challenge_required",
					`${hostname} 在 ${label} 中也${wall.reason}，需要人工处理一次。在 MyHarness 交互界面中再次读取时会打开 ${label} 窗口让你完成，之后的访问会复用这次的登录或验证。${note()}`,
				);
			}
			const declined = this.declined.get(hostname);
			if (declined && declined.until > this.options.now()) {
				throw new WebSearchError("challenge_required", `${declined.message} 短时间内不再为这个网站弹出窗口。`);
			}
			onProgress?.(
				`${hostname} ${wall.reason}：已打开 ${label} 窗口，请在窗口中完成（最长等待 3 分钟，Esc 取消）。完成后会自动继续读取正文。`,
			);
			try {
				page = await browser.solveChallenge({ ...request, isSolved: (candidate) => !wallOf(candidate) }, signal);
			} catch (error) {
				if (!(error instanceof WebSearchError) || error.code !== "challenge_required") throw error;
				const message = `${hostname} ${wall.reason}，但没有完成：${error.message}${note()}`;
				this.declined.set(hostname, { until: this.options.now() + DECLINED_COOLDOWN_MS, message });
				throw new WebSearchError("challenge_required", message, { cause: error });
			}
			this.declined.delete(hostname);
			onProgress?.(`${hostname} 已通过，正在读取正文。`);
		}

		// The browser followed the redirects itself: where it ended up must still be a public address.
		const landed = validatePublicHttpUrl(page.url);
		if (!landed.ok || !landed.url || !landed.hostname) {
			throw new WebSearchError("blocked", `页面跳转到了不允许的地址：${landed.message ?? page.url}`);
		}
		const resolvedProblem = await checkResolvedHost(landed.hostname, this.options.lookup);
		if (resolvedProblem) throw new WebSearchError("blocked", resolvedProblem);

		const remaining = wallOf(page);
		if (remaining) throw wallError(remaining, landed.hostname, `，在 ${label} 中打开也是如此`);
		const converted = htmlToMarkdown(page.text, landed.url);
		if (!converted.markdown) {
			throw new WebSearchError("empty_content", `在 ${label} 中打开后，页面仍然没有可读取的正文。`);
		}
		const cut = converted.markdown.length > PAGE_LIMITS.maxMarkdownChars;
		return {
			finalUrl: landed.url,
			title: converted.title,
			publishedAt: converted.publishedAt,
			markdown: cut ? converted.markdown.slice(0, PAGE_LIMITS.maxMarkdownChars) : converted.markdown,
			truncated: cut,
		};
	}
}
