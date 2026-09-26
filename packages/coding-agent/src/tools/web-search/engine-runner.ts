import type { WebSearchEngineId } from "../../config/settings/types.ts";
import { WEB_SEARCH_ENGINES } from "./engines/index.ts";
import type { BrowserSearch, EngineContext, EngineQuery, EngineResult, SearchEngine } from "./engines/types.ts";
import { abortError, isAccessBlock, WebSearchError } from "./errors.ts";
import type { BrowserTransport, HttpTransport, TransportPage } from "./transport.ts";
import type { WebSearchKeySource } from "./types.ts";

export const ENGINE_RUNNER_LIMITS = {
	/**
	 * Lightweight blocks are often per request (Google answers some requests with
	 * a CAPTCHA and the next one normally), so a single block only moves that one
	 * query to Firefox. After this many blocks in a row the lightweight path is
	 * skipped for `lightweightSkipMs`.
	 */
	lightweightBlocksBeforeSkip: 2,
	lightweightSkipMs: 3 * 60_000,
	/** An engine that refused us on every usable path is not asked again for this long. */
	engineCooldownMs: 2 * 60_000,
	/** Minimum gap between two Firefox loads for the same engine, so bursts do not look like a bot. */
	browserSpacingMs: 1_500,
} as const;

/** How one engine answered one query. */
export interface EngineRun {
	results: EngineResult[];
	via: "http" | "browser";
	/** Why the browser was used, when it was. */
	note?: string;
}

export interface EngineCooldown {
	remainingMs: number;
	/** The failure that started the cooldown. */
	reason: WebSearchError;
}

export interface EngineRunnerOptions {
	http: HttpTransport;
	/** Undefined when no browser transport exists at all (tests, embedders). */
	browser?: BrowserTransport;
	keys?: WebSearchKeySource;
	now: () => number;
	/** The user's "Firefox Fallback" setting. */
	browserFallbackEnabled: () => boolean;
	/** True when a person is at the terminal and may be asked to pass a CAPTCHA in Firefox. */
	interactiveChallenges: () => boolean;
	/** Overrides ENGINE_RUNNER_LIMITS.browserSpacingMs (tests). */
	browserSpacingMs?: number;
}

interface EngineState {
	consecutiveLightweightBlocks: number;
	skipLightweightUntil: number;
	cooldownUntil: number;
	cooldownReason?: WebSearchError;
	nextBrowserLoadAt: number;
}

/**
 * Runs one engine for one query: lightweight first, the real browser only for
 * access blocks (see isAccessBlock). Parser failures, unrecognized pages and
 * exceptions propagate unchanged, so they are reported instead of hidden.
 */
export class EngineRunner {
	private readonly options: EngineRunnerOptions;
	private readonly states = new Map<WebSearchEngineId, EngineState>();

	constructor(options: EngineRunnerOptions) {
		this.options = options;
	}

	private state(engine: WebSearchEngineId): EngineState {
		let state = this.states.get(engine);
		if (!state) {
			state = { consecutiveLightweightBlocks: 0, skipLightweightUntil: 0, cooldownUntil: 0, nextBrowserLoadAt: 0 };
			this.states.set(engine, state);
		}
		return state;
	}

	/** The engine's current cooldown, if it is in one. */
	cooldown(engine: WebSearchEngineId): EngineCooldown | undefined {
		const state = this.states.get(engine);
		const remainingMs = Math.max(0, (state?.cooldownUntil ?? 0) - this.options.now());
		return remainingMs > 0 && state?.cooldownReason ? { remainingMs, reason: state.cooldownReason } : undefined;
	}

	private startCooldown(engine: WebSearchEngineId, reason: WebSearchError): void {
		const state = this.state(engine);
		state.cooldownUntil = this.options.now() + ENGINE_RUNNER_LIMITS.engineCooldownMs;
		state.cooldownReason = reason;
	}

	/** Whether the browser path can be used for this engine right now, or why not. */
	private browserPath(engine: SearchEngine): { search: BrowserSearch } | { reason: string } {
		if (!engine.browser) return { reason: `${engine.label} 没有浏览器通道。` };
		if (!this.options.browserFallbackEnabled()) {
			return { reason: "Firefox Fallback 已在 /settings → Web Search 中关闭。" };
		}
		if (!this.options.browser) return { reason: "当前运行环境没有浏览器通道。" };
		const state = this.options.browser.state();
		if (!state.available) return { reason: state.reason };
		return { search: engine.browser };
	}

	async run(
		engineId: WebSearchEngineId,
		query: Omit<EngineQuery, "apiKey">,
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<EngineRun> {
		const engine = WEB_SEARCH_ENGINES[engineId];
		const state = this.state(engineId);
		const engineQuery: EngineQuery = {
			...query,
			apiKey: engine.requiresApiKey ? this.options.keys?.get("brave_api") : undefined,
		};
		const context: EngineContext = { http: this.options.http, signal, now: this.options.now };
		const browser = this.browserPath(engine);
		const skipLightweight = "search" in browser && state.skipLightweightUntil > this.options.now();

		let lightweightBlock: WebSearchError | undefined;
		if (!skipLightweight) {
			try {
				const results = await engine.search(engineQuery, context);
				state.consecutiveLightweightBlocks = 0;
				return { results, via: "http" };
			} catch (error) {
				if (!isAccessBlock(error)) throw error;
				lightweightBlock = error;
				state.consecutiveLightweightBlocks += 1;
				if (!("search" in browser)) {
					// Nothing else to try: stop asking this engine for a while.
					const reported = new WebSearchError(
						error.code,
						engine.browser ? `${error.message} 无法改用 Firefox：${browser.reason}` : error.message,
						{ cause: error },
					);
					this.startCooldown(engineId, reported);
					throw reported;
				}
				if (state.consecutiveLightweightBlocks >= ENGINE_RUNNER_LIMITS.lightweightBlocksBeforeSkip) {
					state.skipLightweightUntil = this.options.now() + ENGINE_RUNNER_LIMITS.lightweightSkipMs;
					state.consecutiveLightweightBlocks = 0;
				}
			}
		}

		try {
			const results = await this.searchInBrowser(engine, state, browser.search, engineQuery, context, onProgress);
			return {
				results,
				via: "browser",
				note: lightweightBlock
					? `轻量请求被拦截（${lightweightBlock.message}），已改用 Firefox。`
					: "轻量请求连续被拦截，暂时直接使用 Firefox。",
			};
		} catch (error) {
			const reported =
				lightweightBlock && error instanceof WebSearchError && error.code !== "aborted"
					? new WebSearchError(error.code, `轻量请求：${lightweightBlock.message} Firefox：${error.message}`, {
							cause: error,
						})
					: error;
			// Refused in the real browser too: stop asking this engine for a while.
			if (
				reported instanceof WebSearchError &&
				(reported.code === "challenge_required" || isAccessBlock(reported))
			) {
				this.startCooldown(engineId, reported);
			}
			throw reported;
		}
	}

	/** Wait until this engine may use Firefox again (see browserSpacingMs). */
	private async paceBrowser(state: EngineState, signal: AbortSignal | undefined): Promise<void> {
		const now = this.options.now();
		const startAt = Math.max(now, state.nextBrowserLoadAt);
		state.nextBrowserLoadAt = startAt + (this.options.browserSpacingMs ?? ENGINE_RUNNER_LIMITS.browserSpacingMs);
		const waitMs = startAt - now;
		if (waitMs <= 0) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, waitMs);
			const onAbort = () => {
				clearTimeout(timer);
				reject(abortError(signal));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async searchInBrowser(
		engine: SearchEngine,
		state: EngineState,
		search: BrowserSearch,
		query: EngineQuery,
		context: EngineContext,
		onProgress: ((message: string) => void) | undefined,
	): Promise<EngineResult[]> {
		const browser = this.options.browser!;
		const request = search.request(query);
		await this.paceBrowser(state, context.signal);
		let page = await browser.load(request, context.signal);
		try {
			search.checkAccess(page);
		} catch (error) {
			const needsPerson = error instanceof WebSearchError && (error.code === "captcha" || error.code === "consent");
			if (!needsPerson) throw error;
			if (!this.options.interactiveChallenges()) {
				throw new WebSearchError(
					"challenge_required",
					`${engine.label} 在 Firefox 中也要求人机验证，需要人工完成一次。在 MyHarness 交互界面中再次搜索时会打开 Firefox 窗口让你完成，之后的搜索会复用这次验证。`,
					{ cause: error },
				);
			}
			onProgress?.(
				`${engine.label} 要求人机验证：已打开 Firefox 窗口，请在窗口中完成验证（最长等待 3 分钟，Esc 取消）。`,
			);
			page = await browser.solveChallenge(
				{
					...request,
					isSolved: (candidate: TransportPage) => {
						if (candidate.ready === false) return false;
						try {
							search.checkAccess(candidate);
							return true;
						} catch {
							return false;
						}
					},
				},
				context.signal,
			);
		}
		return search.parse(page, query, context);
	}
}
