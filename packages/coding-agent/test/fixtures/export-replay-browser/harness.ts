/**
 * W27b — shared harness for the web export replay browser E2E tests.
 *
 * Relocated verbatim from test/web-export-replay-browser.test.ts (W25, green since W27a):
 * the test-owned CDP helper, the 41-assertion table, runScenario/expectAllPass, and the
 * small-session fixture. The W27c (big session), W27d (offline/copy-rename), and W27e
 * (negative proof) follow-ups import from here instead of copying the helpers.
 *
 * Pure relocation: no assertion, selector, timeout, or fixture behavior changed here.
 * The only addition is writeExportHtml, extracted from the original beforeAll.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { SessionManager } from "../../../src/session/manager/index.ts";
import { launchChromium } from "../../../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers } from "../../../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
export const chromeInstall =
	installed.find((entry) => entry.kind === "chrome") ?? installed.find((entry) => entry.kind === "edge");
export const gated = process.env.MYHARNESS_TARGETED_BROWSER_E2E === "1" && chromeInstall !== undefined;

// ---------------------------------------------------------------- CDP helper (test-owned)

export interface CdpMessage {
	method?: string;
	params?: Record<string, unknown>;
}

/**
 * Runtime view over the private members of CdpBridge (send/onEvent). Same borrowing
 * technique as the W20 spike's browser.mjs: wrap onEvent, call send through the bridge.
 */
export interface CdpBridgeView {
	init(headless: boolean, brand: string): Promise<void>;
	send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
	onEvent(message: CdpMessage): void;
	quit(): Promise<void>;
	close(): void;
}

export interface ConsoleRecord {
	type: string;
	text: string;
}

export interface NetworkRecord {
	event: string;
	url: string;
	error: string;
}

export interface ScenarioSummary {
	consoleErrors: ConsoleRecord[];
	pageErrors: ConsoleRecord[];
	failedRequests: NetworkRecord[];
	nonFileRequests: NetworkRecord[];
}

export class ExportCdpBrowser {
	private consoleRecords: ConsoleRecord[] = [];
	private pageErrors: ConsoleRecord[] = [];
	private network: NetworkRecord[] = [];
	private requestUrls = new Map<string, string>();
	private bridgeView: CdpBridgeView | undefined;
	private sessionId = "";
	private launched: { pid: number } | undefined;
	private readonly kind: "chrome" | "edge";
	private readonly executable: string;
	readonly profileDir: string;
	private readonly offline: boolean;

	constructor(kind: "chrome" | "edge", executable: string, profileDir: string, offline: boolean) {
		this.kind = kind;
		this.executable = executable;
		this.profileDir = profileDir;
		this.offline = offline;
	}

	async start(): Promise<void> {
		mkdirSync(this.profileDir, { recursive: true });
		const brand = this.kind === "edge" ? "Microsoft Edge" : "Google Chrome";
		const launch = launchChromium({
			executable: this.executable,
			profileDir: this.profileDir,
			headless: true,
			brand,
		});
		this.launched = { pid: launch.child.pid ?? 0 };
		const view = launch.bridge as unknown as CdpBridgeView;
		this.bridgeView = view;
		console.log(`[cdp] chrome launched pid=${String(launch.child.pid)} profile=${this.profileDir}`);
		const initDeadline = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("bridge.init timed out after 60000ms")), 60_000).unref();
		});
		await Promise.race([view.init(true, brand), initDeadline]);
		console.log("[cdp] bridge init done");
		const originalOnEvent = view.onEvent.bind(view);
		view.onEvent = (message: CdpMessage) => {
			this.collectEvent(message);
			originalOnEvent(message);
		};
	}

	private collectEvent(message: CdpMessage): void {
		const params = message.params ?? {};
		if (message.method === "Runtime.consoleAPICalled") {
			const type = String(params.type ?? "");
			if (type === "error" || type === "warning") {
				const args = (params.args ?? []) as Array<Record<string, unknown>>;
				const text = args.map((a) => String(a.value ?? a.description ?? a.type ?? "")).join(" ");
				this.consoleRecords.push({ type, text });
			}
		} else if (message.method === "Runtime.exceptionThrown") {
			const details = (params.exceptionDetails ?? {}) as Record<string, unknown>;
			const exception = (details.exception ?? {}) as Record<string, unknown>;
			this.pageErrors.push({ type: "exception", text: String(exception.description ?? details.text ?? "unknown") });
		} else if (message.method === "Log.entryAdded") {
			const entry = (params.entry ?? {}) as Record<string, unknown>;
			const level = String(entry.level ?? "");
			if (level === "error" || level === "warning") {
				this.consoleRecords.push({
					type: `log:${level}`,
					text: `${String(entry.source ?? "")} ${String(entry.text ?? "")}`.trim(),
				});
			}
		} else if (message.method?.startsWith("Network.")) {
			if (message.method === "Network.requestWillBeSent" && params.requestId) {
				const request = (params.request ?? {}) as Record<string, unknown>;
				this.requestUrls.set(String(params.requestId), String(request.url ?? ""));
			}
			const request = (params.request ?? {}) as Record<string, unknown>;
			const response = (params.response ?? {}) as Record<string, unknown>;
			const url = String(request.url ?? params.url ?? this.requestUrls.get(String(params.requestId ?? "")) ?? "");
			if (this.network.length < 600) {
				this.network.push({ event: message.method, url, error: String(params.errorText ?? response.status ?? "") });
			}
		}
	}

	private async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.rpc(method, params ?? {}, this.sessionId);
	}

	/** Chrome replies by id; if it never answers, race a timeout so diagnostics surface. */
	private async rpc(
		method: string,
		params: Record<string, unknown>,
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		const view = this.bridgeView;
		if (!view) throw new Error("browser not started");
		const deadline = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`CDP ${method} timed out after 30000ms`)), 30_000).unref();
		});
		return await Promise.race([view.send(method, params, sessionId), deadline]);
	}

	/** Opens a file:// URL in a fresh target and waits for the ready selector. */
	async open(url: string, readySelector: string, timeoutMs: number, settleMs: number): Promise<boolean> {
		const created = await this.rpc("Target.createTarget", { url: "about:blank" });
		const targetId = String(created.targetId ?? "");
		const attached = await this.rpc("Target.attachToTarget", { targetId, flatten: true });
		this.sessionId = String(attached.sessionId ?? "");
		console.log(`[cdp] target created sessionId=${this.sessionId}`);
		await this.send("Page.enable");
		await this.send("Network.enable");
		await this.send("Runtime.enable");
		await this.send("Log.enable");
		if (this.offline) {
			await this.send("Network.emulateNetworkConditions", {
				offline: true,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
		}
		await this.send("Page.navigate", { url });
		console.log(`[cdp] navigating ${url}`);
		const deadline = Date.now() + timeoutMs;
		let probeRound = 0;
		while (Date.now() < deadline) {
			const probe = await this.evaluate<{ ready: boolean; state?: string }>(
				`(function(){try{return {state:document.readyState,ready:!!document.querySelector(${JSON.stringify(readySelector)})}}catch(e){return {state:"error",ready:false}}})()`,
			);
			if (probe.ready) {
				console.log(`[cdp] ready after ${probeRound} probes`);
				const settleStart = Date.now();
				while (Date.now() - settleStart < settleMs) await new Promise((resolve) => setTimeout(resolve, 100));
				return true;
			}
			if (probeRound % 25 === 0) console.log(`[cdp] probe ${probeRound} state=${String(probe.state)}`);
			probeRound += 1;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return false;
	}

	async evaluate<T>(expression: string): Promise<T> {
		const reply = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		const exceptionDetails = reply.exceptionDetails as Record<string, unknown> | undefined;
		if (exceptionDetails) {
			const exception = (exceptionDetails.exception ?? {}) as Record<string, unknown>;
			throw new Error(`page threw: ${String(exception.description ?? exceptionDetails.text ?? "unknown")}`);
		}
		const result = (reply.result ?? {}) as Record<string, unknown>;
		return result.value as T;
	}

	async screenshot(filePath: string): Promise<number> {
		const reply = await this.send("Page.captureScreenshot", { format: "png" });
		const data = String(reply.data ?? "");
		const buf = Buffer.from(data, "base64");
		writeFileSync(filePath, buf);
		return buf.length;
	}

	summary(): ScenarioSummary {
		const failed = this.network.filter(
			(entry) => entry.event === "Network.loadingFailed" && entry.error !== "net::ERR_ABORTED",
		);
		const nonFile = this.network.filter(
			(entry) => entry.event === "Network.requestWillBeSent" && !/^(file|data|about):/.test(entry.url),
		);
		return {
			consoleErrors: this.consoleRecords.filter((c) => c.type === "error" || c.type === "log:error"),
			pageErrors: this.pageErrors,
			failedRequests: failed,
			nonFileRequests: nonFile,
		};
	}

	pid(): number | undefined {
		return this.launched?.pid;
	}

	async close(): Promise<void> {
		if (!this.bridgeView) return;
		try {
			await this.bridgeView.quit();
		} catch {
			// already gone
		}
		this.bridgeView.close();
		if (this.launched) {
			try {
				process.kill(this.launched.pid);
			} catch {
				// already exited
			}
		}
	}
}

// ---------------------------------------------------------------- assertion table (ported from verify-export.mjs)

export const CONTAINER = ".transcript-inner";

export const CATEGORY_ASSERTIONS: Array<[string, string, number]> = [
	["用户消息", ".user-row", 1],
	["用户图片附件", ".user-row img", 1],
	["助手正文（Markdown）", ".final", 2],
	["助手逐条 Token/费用小字", ".msg-meta", 1],
	["思考块", ".thinking", 1],
	["工具步骤行", ".action-row", 3],
	["步骤聚合块", ".steps", 1],
	["变更卡片（web-run-changes）", ".change-card", 1],
	["custom 卡片（custom_message / web-git-status）", ".custom-card", 1],
	["bash 行（! 命令）", ".bash-entry", 1],
	["内联图片（data:）", ".transcript img", 1],
	["Markdown 表格", ".final table", 1],
	["代码块", ".final pre code", 1],
];

export const UI_ASSERTIONS: Array<[string, string, number]> = [
	["侧栏底部只读导出区（ExportSidebarFoot）", ".sidebar .export-side-foot", 1],
	["顶部只读徽章", ".export-top-badge", 1],
	["侧栏下载原始 JSONL 按钮", ".export-side-foot button", 1],
	["需要服务端的按钮已禁用", "button.export-offline", 3],
	["侧栏列出被导出的对话", ".sidebar .chat-item, .sidebar [class*=chat]", 1],
];

export interface DiagSnapshot {
	hasGlobal: boolean;
	missingRoutes: string[];
	title: string;
	lang: string;
	theme: string;
	colorTheme: string;
	exportReadonly: string;
	rawJsonlChars: number;
	splash: boolean;
	splashText: string;
	connBanner: boolean;
	toasts: string[];
	counts: Record<string, number>;
	resources: Array<{ name: string; initiator: string; size: number }>;
	loadEventStart: number;
	domContentLoaded: number;
	firstPaint: number | null;
}

export interface AfterSnapshot {
	msgMeta: number;
	raw: number;
	rawPre: number;
	dl: number;
	hunk: number;
	marker: number;
	markerBody: number;
	turns: number;
	earlierLeft: number;
	missingRoutes: string[];
}

export interface AssertionRow {
	name: string;
	ok: boolean;
	detail: string;
}

export function diagExpression(): string {
	const selectors = JSON.stringify(
		Object.fromEntries([...CATEGORY_ASSERTIONS, ...UI_ASSERTIONS].map(([name, sel]) => [name, sel])),
	);
	return `(function(){
		var E = window.__MYHARNESS_EXPORT__ || {};
		var itemsBox = document.querySelector(${JSON.stringify(CONTAINER)});
		var counts = {};
		var selectors = ${selectors};
		for (var name in selectors) {
			try { counts[name] = document.querySelectorAll(selectors[name]).length } catch (e) { counts[name] = -1 }
		}
		return {
			hasGlobal: !!window.__MYHARNESS_EXPORT__,
			missingRoutes: (E.missingRoutes || []),
			title: document.title,
			lang: document.documentElement.lang,
			theme: document.documentElement.dataset.theme,
			colorTheme: document.documentElement.dataset.colorTheme,
			exportReadonly: document.documentElement.dataset.exportReadonly,
			itemCount: itemsBox ? itemsBox.querySelectorAll(".turn").length : 0,
			counts: counts,
			resources: performance.getEntriesByType("resource").map(function (r) { return { name: (r.name || "").slice(0, 120), initiator: r.initiatorType, size: r.transferSize } }),
			loadEventStart: performance.timing.loadEventStart - performance.timing.navigationStart,
			domContentLoaded: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart,
			firstPaint: (function () { var e = performance.getEntriesByName("first-contentful-paint")[0]; return e ? Math.round(e.startTime) : null })(),
			splash: !!document.querySelector(".splash"),
			splashText: (document.querySelector(".splash") ? document.querySelector(".splash").innerText : "").slice(0, 200),
			connBanner: !!document.querySelector(".conn-banner"),
			toasts: [].map.call(document.querySelectorAll(".toast"), function (t) { return t.innerText.slice(0, 80) }),
			rawJsonlChars: (E.data && E.data.rawJsonl ? E.data.rawJsonl.length : 0),
		};
	})()`;
}

export const INTERACT_EXPRESSION = `(function(){
	var click = function (sel) { var n = document.querySelector(sel); if (n) { n.click(); return true } return false };
	var clicked = [];
	var earlier = 0;
	while (document.querySelector('.earlier') && earlier < 12) { document.querySelector('.earlier').click(); earlier++; }
	clicked.push(['earlier-clicks', earlier]);
	clicked.push(['action-row', click('.action .action-row')]);
	clicked.push(['marker-head', click('.marker-head')]);
	clicked.push(['change-file', click('.change-file')]);
	return { clicked: clicked };
})()`;

export const AFTER_EXPRESSION = `(function(){
	var q = function (s) { return document.querySelectorAll(s).length };
	var E = window.__MYHARNESS_EXPORT__ || {};
	return {
		msgMeta: q('.msg-meta'), raw: q('.raw'), rawPre: q('.raw-pre'), dl: q('.dl'), hunk: q('.hunk'),
		marker: q('.marker'), markerBody: q('.marker-body'), turns: q('.turn'), earlierLeft: q('.earlier'),
		missingRoutes: (E.missingRoutes || [])
	};
})()`;

// ---------------------------------------------------------------- W125 read-only lockdown probes

/** Palette command labels that must not exist in a read-only export copy (they would only hit the 405 fakeFetch). */
export const W125_HIDDEN_PALETTE_LABELS = [
	"新对话",
	"压缩上下文",
	"Commit 改动",
	"Push 到上游",
	"撤销或保留任务改动",
	"Git 工具与 Worktree",
	"切换模型",
	"设置",
	"Provider 与 API Key",
	"导出对话为 HTML",
	"主题：深色",
	"主题：浅色",
	"主题：跟随系统",
	"语言：English",
	"语言：简体中文",
];

export interface W125LockdownSnapshot {
	localAnchors: number;
	hasMarker: boolean;
	markerAnchors: number;
	sidebarFootNavBtns: number;
	downloadExists: boolean;
	downloadDisabled: boolean;
	filterInputs: number;
	fileInputs: number;
}

export interface W125PaletteSnapshot {
	open: boolean;
	labels: string[];
	emptyGroups: number;
}

export interface W125FetchWindowSnapshot {
	calls: number;
	toasts: number;
	paletteOpen: boolean;
}

export interface W125SelectionSnapshot {
	selectedChars: number;
}

export interface W125QuoteSnapshot {
	bar: boolean;
	card: boolean;
	selectionChars: number;
}

export const W125_STATIC_EXPRESSION = `(function(){
	var q = function (s) { return document.querySelectorAll(s).length };
	var dl = document.querySelector(".export-side-foot button.export-side-download");
	var body = (document.querySelector(".transcript") || { textContent: "" }).textContent || "";
	return {
		localAnchors: q("a[data-local-path]"),
		hasMarker: body.indexOf("查看应用入口") >= 0,
		markerAnchors: [].filter.call(document.querySelectorAll(".transcript a"), function (n) { return (n.textContent || "").indexOf("查看应用入口") >= 0 }).length,
		sidebarFootNavBtns: q(".sidebar-foot .nav-btn"),
		downloadExists: !!dl,
		downloadDisabled: dl ? !!dl.disabled : true,
		filterInputs: q(".sidebar-search input"),
		fileInputs: q("input[type=file]"),
	};
})()`;

export const W125_INSTALL_FETCH_COUNTER = `(function(){
	var E = window.__MYHARNESS_EXPORT__;
	if (E && typeof E.fetch === "function" && !E.__W125_ORIG_FETCH__) {
		E.__W125_ORIG_FETCH__ = E.fetch;
		window.__W125_FETCH_CALLS__ = 0;
		E.fetch = function () { window.__W125_FETCH_CALLS__++; return E.__W125_ORIG_FETCH__.apply(E, arguments); };
	}
	return { installed: !!(E && E.__W125_ORIG_FETCH__) };
})()`;

export const W125_OPEN_PALETTE_EXPRESSION = `(function(){
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
	return true;
})()`;

export const W125_NEW_CHAT_KEY_EXPRESSION = `(function(){
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
	return true;
})()`;

export const W125_PALETTE_EXPRESSION = `(function(){
	var labels = [].map.call(document.querySelectorAll(".palette .palette-item .truncate"), function (n) { return (n.textContent || "").trim() });
	var emptyGroups = [].filter.call(document.querySelectorAll(".palette-list .pop-group"), function (n) {
		return !n.nextElementSibling || !n.nextElementSibling.classList.contains("palette-item");
	}).length;
	return { open: !!document.querySelector(".palette"), labels: labels, emptyGroups: emptyGroups };
})()`;

export const W125_CLOSE_PALETTE_EXPRESSION = `(function(){
	var input = document.querySelector(".palette-input input");
	if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	return true;
})()`;

export const W125_FETCH_WINDOW_EXPRESSION = `(function(){
	return { calls: window.__W125_FETCH_CALLS__ || 0, toasts: document.querySelectorAll(".toast").length, paletteOpen: !!document.querySelector(".palette") };
})()`;

export const W125_SELECT_EXPRESSION = `(function(){
	var target = document.querySelector(".transcript .final") || document.querySelector(".transcript .user-row .user-text");
	if (!target) return { selectedChars: 0 };
	var range = document.createRange();
	range.selectNodeContents(target);
	var sel = window.getSelection();
	sel.removeAllRanges();
	sel.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
	return { selectedChars: String(sel.toString()).length };
})()`;

export const W125_QUOTE_EXPRESSION = `(function(){
	return {
		bar: !!document.querySelector(".floating-quote-bar"),
		card: !!document.querySelector(".quote-note-card"),
		selectionChars: String(window.getSelection().toString()).length,
	};
})()`;

export const W125_CLEAR_SELECTION_EXPRESSION = `(function(){
	var s = window.getSelection();
	if (s) s.removeAllRanges();
	return true;
})()`;

/** Runs one full scenario (fresh browser, fresh --user-data-dir) and returns the assertion table
 * (the original 41 rows plus the W125 read-only lockdown rows). */
export async function runScenario(
	label: string,
	htmlPath: string,
	options: { offline: boolean; expectedName: string },
): Promise<AssertionRow[]> {
	const results: AssertionRow[] = [];
	const assert = (name: string, ok: boolean, detail = ""): void => {
		results.push({ name, ok: !!ok, detail: String(detail).slice(0, 220) });
	};
	const kind: "chrome" | "edge" = chromeInstall?.kind === "edge" ? "edge" : "chrome";
	const profileDir = mkdtempSync(
		join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), `w25-profile-${label.replace(/[^a-z0-9]+/gi, "-")}-`),
	);
	const browser = new ExportCdpBrowser(kind, chromeInstall?.executable ?? "", profileDir, options.offline);
	try {
		await browser.start();
		console.log(`[${label}] browser pid=${String(browser.pid())} profile=${profileDir}`);
		const opened = await browser.open(pathToFileURL(htmlPath).href, `${CONTAINER} > *`, 120_000, 4_000);
		assert("首屏渲染出对话内容（容器里有节点）", opened, `readySelector=${CONTAINER} > *`);

		const diag = await browser.evaluate<DiagSnapshot>(diagExpression());
		console.log(`[${label}] diag done`);
		assert("导出外壳全局存在（window.__MYHARNESS_EXPORT__）", diag.hasGlobal);
		assert("没有出现启动页/错误页（.splash 不存在）", !diag.splash, diag.splashText);
		assert("没有「连接已断开」横幅", !diag.connBanner);
		assert("界面上没有报错 toast", (diag.toasts ?? []).length === 0, JSON.stringify(diag.toasts));
		assert(
			`标题是对话名（含「${options.expectedName}」）`,
			(diag.title ?? "").includes(options.expectedName),
			diag.title,
		);
		assert("语言与导出时一致（zh-CN）", diag.lang === "zh-CN", `lang=${String(diag.lang)}`);
		assert(
			"主题与导出时一致（light + forest）",
			diag.theme === "light" && diag.colorTheme === "forest",
			`theme=${String(diag.theme)} colorTheme=${String(diag.colorTheme)}`,
		);
		assert(
			"导出标识 data-export-readonly",
			diag.exportReadonly === "1",
			`exportReadonly=${String(diag.exportReadonly)}`,
		);
		assert("内嵌原始 JSONL（下载入口有内容）", diag.rawJsonlChars > 0, `${String(diag.rawJsonlChars)} chars`);

		for (const [name, selector, min] of [...CATEGORY_ASSERTIONS, ...UI_ASSERTIONS]) {
			const got = diag.counts?.[name] ?? 0;
			assert(`内容类型 ${name}（${selector} ≥ ${min}）`, got >= min, `实测 ${got}`);
		}

		const interact = await browser.evaluate<{ clicked: Array<[string, boolean | number]> }>(INTERACT_EXPRESSION);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		const after = await browser.evaluate<AfterSnapshot>(AFTER_EXPRESSION);
		assert(
			"交互 展开工具步骤后出现原始结果（.raw ≥ 1）",
			after.raw >= 1,
			`实测 .raw=${after.raw} .raw-pre=${after.rawPre}（点击=${JSON.stringify(interact.clicked)}）`,
		);
		assert(
			"交互 展开变更卡片文件后出现 Diff 行号（.dl ≥ 1）",
			after.dl >= 1,
			`实测 .dl=${after.dl} .hunk=${after.hunk}（Diff 来自内嵌 card-diff 路由）`,
		);
		assert(
			"交互 展开压缩/分支摘要后显示正文（.marker-body ≥ 1）",
			after.markerBody >= 1,
			`实测 .marker-body=${after.markerBody}`,
		);
		assert(
			"交互 点开「显示更早的消息」后压缩/分支摘要标记出现（.marker ≥ 2）",
			after.marker >= 2,
			`实测 .marker=${after.marker} .turn=${after.turns} 更早按钮剩余=${after.earlierLeft}`,
		);
		assert(
			"交互 展开后 .msg-meta 仍来自 turn.final（信息项）",
			true,
			`.msg-meta=${after.msgMeta} .turn=${after.turns} 更早按钮剩余=${after.earlierLeft}`,
		);
		assert(
			"交互 之后仍未覆盖的 GET 路由数为 0",
			(after.missingRoutes ?? []).length === 0,
			JSON.stringify([...new Set(after.missingRoutes ?? [])].slice(0, 8)),
		);

		// ---- W125 只读收口：只会撞 405 的入口必须在只读页消失（命令面板 / 快捷键 / 划词引用 / 本地链接 / 设置入口）
		const lockdown = await browser.evaluate<W125LockdownSnapshot>(W125_STATIC_EXPRESSION);
		assert(
			"只读页正文没有 a[data-local-path] 本地链接锚点",
			lockdown.localAnchors === 0,
			`实测 ${lockdown.localAnchors}`,
		);
		assert(
			"本地路径链接保留文字且不是 <a>（夹具探针）",
			!lockdown.hasMarker || lockdown.markerAnchors === 0,
			`hasMarker=${lockdown.hasMarker} markerAnchors=${lockdown.markerAnchors}`,
		);
		assert("只读页侧栏底部没有设置入口", lockdown.sidebarFootNavBtns === 0, `实测 ${lockdown.sidebarFootNavBtns}`);
		assert(
			"保留 下载原始 JSONL 按钮可用",
			lockdown.downloadExists && !lockdown.downloadDisabled,
			`exists=${lockdown.downloadExists} disabled=${lockdown.downloadDisabled}`,
		);
		assert("保留 侧栏筛选与搜索输入框", lockdown.filterInputs >= 1, `实测 ${lockdown.filterInputs}`);
		assert("只读页没有文件上传入口（input[type=file]）", lockdown.fileInputs === 0, `实测 ${lockdown.fileInputs}`);

		const counterInstall = await browser.evaluate<{ installed: boolean }>(W125_INSTALL_FETCH_COUNTER);
		await browser.evaluate(W125_OPEN_PALETTE_EXPRESSION);
		await new Promise((resolve) => setTimeout(resolve, 600));
		const palette = await browser.evaluate<W125PaletteSnapshot>(W125_PALETTE_EXPRESSION);
		const hiddenHits = W125_HIDDEN_PALETTE_LABELS.filter((label) => palette.labels.includes(label));
		assert(
			"只读页命令面板不含写服务端/设置/语言主题/再导出条目",
			counterInstall.installed && palette.open && hiddenHits.length === 0,
			`installed=${counterInstall.installed} open=${palette.open} hits=${JSON.stringify(hiddenHits)}`,
		);
		assert(
			"只读页命令面板保留「显示/隐藏侧栏」",
			palette.labels.includes("显示/隐藏侧栏"),
			palette.labels.join(" | "),
		);
		assert("只读页命令面板过滤后没有空分组", palette.emptyGroups === 0, `实测 ${palette.emptyGroups}`);
		await browser.evaluate(W125_CLOSE_PALETTE_EXPRESSION);
		await new Promise((resolve) => setTimeout(resolve, 400));

		const nBefore = await browser.evaluate<W125FetchWindowSnapshot>(W125_FETCH_WINDOW_EXPRESSION);
		await browser.evaluate(W125_NEW_CHAT_KEY_EXPRESSION);
		await new Promise((resolve) => setTimeout(resolve, 600));
		const nAfter = await browser.evaluate<W125FetchWindowSnapshot>(W125_FETCH_WINDOW_EXPRESSION);
		assert(
			"Ctrl+Alt+N 在只读页不产生任何请求（fakeFetch 计数增量 0）",
			nBefore.paletteOpen === false && nAfter.calls === nBefore.calls && nAfter.toasts === 0,
			`paletteOpen=${nBefore.paletteOpen} calls ${nBefore.calls}→${nAfter.calls} toasts=${nAfter.toasts}`,
		);

		const selection = await browser.evaluate<W125SelectionSnapshot>(W125_SELECT_EXPRESSION);
		await new Promise((resolve) => setTimeout(resolve, 400));
		const quote = await browser.evaluate<W125QuoteSnapshot>(W125_QUOTE_EXPRESSION);
		assert(
			"选中正文后没有 Quote 气泡/批注卡片（划词引用未挂载）",
			selection.selectedChars > 0 && !quote.bar && !quote.card,
			`selected=${selection.selectedChars} bar=${quote.bar} card=${quote.card}`,
		);
		assert(
			"保留 划词原生选区可用（浏览器复制不受影响）",
			quote.selectionChars > 0,
			`仍选中 ${quote.selectionChars} 字`,
		);
		await browser.evaluate(W125_CLEAR_SELECTION_EXPRESSION);

		const summary = browser.summary();
		assert(
			"控制台 0 个错误",
			summary.consoleErrors.length === 0,
			summary.consoleErrors.map((c) => `${c.type}: ${c.text}`).join(" | "),
		);
		assert("页面无未捕获异常", summary.pageErrors.length === 0, summary.pageErrors.map((e) => e.text).join(" | "));
		assert(
			"无失败请求（Network.loadingFailed）",
			summary.failedRequests.length === 0,
			summary.failedRequests.map((r) => `${r.url} ${r.error}`).join(" | "),
		);
		assert(
			"无对 file:// 以外的请求",
			summary.nonFileRequests.length === 0,
			summary.nonFileRequests
				.map((r) => r.url)
				.slice(0, 5)
				.join(" | "),
		);
		const external = (diag.resources ?? []).filter((r) => !/^(file|data|about):/.test(r.name));
		assert(
			"performance resource 条目里没有外部资源",
			external.length === 0,
			external
				.map((r) => r.name)
				.slice(0, 5)
				.join(" | "),
		);
		assert(
			"未覆盖的 GET 路由数为 0（路由表覆盖完整）",
			(diag.missingRoutes ?? []).length === 0,
			JSON.stringify([...new Set(diag.missingRoutes ?? [])].slice(0, 8)),
		);

		const timing = `首屏：FCP=${String(diag.firstPaint)}ms DOMContentLoaded=${diag.domContentLoaded}ms load=${diag.loadEventStart}ms`;
		results.push({ name: "首屏耗时（信息项，不判定）", ok: true, detail: timing });
	} catch (error) {
		assert("加载并诊断页面", false, String(error instanceof Error ? error.message : error));
	} finally {
		await browser.close();
	}

	const table = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
	console.log(
		`[${label}] 断言表 ${results.length} 条，失败 ${results.filter((r) => !r.ok).length} 条\n${table.join("\n")}`,
	);
	return results;
}

export function expectAllPass(label: string, results: AssertionRow[]): void {
	const failures = results.filter((r) => !r.ok);
	expect(
		failures.length,
		`[${label}] 断言失败：\n${failures.map((f) => `FAIL ${f.name} —— ${f.detail}`).join("\n")}`,
	).toBe(0);
}

// ---------------------------------------------------------------- session fixtures

// Valid 1×1 PNGs (red/green/blue) from the spike's make-png.mjs: hand-copied base64 can be
// invalid and breaks the page with net::ERR_INVALID_URL.
export const PNG = {
	red: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	green: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgOBEAAAHkARkh4hVrAAAAAElFTkSuQmCC",
	blue: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgCPgPAAGjAVC5lHV2AAAAAElFTkSuQmCC",
};

export const EXPORT_PREFS: Record<string, unknown> = {
	lang: "zh-CN",
	theme: "light",
	colorThemes: { coding: "forest", general: "amber" },
	colorTheme: "forest",
	motion: "reduce",
	chatMode: "coding",
};

export const SMALL_NAME = "W25 导出端到端小对话";

export type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];
export type AppendUsageArg = Parameters<SessionManager["appendCompaction"]>[5];

/** Loose message builder: the fixture mirrors the JSONL shapes the Web UI renders. */
export const message = (m: unknown): AppendMessageArg => m as AppendMessageArg;
export const usage = (u: unknown): AppendUsageArg => u as AppendUsageArg;

export const usageOf = (input: number, output: number, total: number): Record<string, unknown> => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { input: 0.0004, output: 0.0021, cacheRead: 0, cacheWrite: 0, total: 0.0025 },
});

export const tableMd = (rows: number): string =>
	["| 序号 | 名称 | 数值 | 说明 |", "| ---: | :--- | ---: | :--- |"]
		.concat(
			Array.from(
				{ length: rows },
				(_, i) => `| ${i + 1} | 条目-${i} | ${(i * 37) % 1000} | ${i % 2 ? "通过" : "待处理"} |`,
			),
		)
		.join("\n");

export const codeBlock = (lines: number): string =>
	Array.from(
		{ length: lines },
		(_, i) =>
			`${String(i + 1).padStart(4, "0")}\texport const row${i} = { id: ${i}, name: "第 ${i} 行", ok: ${i % 3 !== 0} };`,
	).join("\n");

export const diffPatch = (file: string, from: number, to: number): string =>
	[
		`--- a/${file}`,
		`+++ b/${file}`,
		`@@ -${from},4 +${to},5 @@`,
		" context line before",
		`-const value = ${from};`,
		`+const value = ${to};`,
		"+const added = true; // 新增的一行",
		" context line after",
	].join("\n");

export const runChangesData = (tag: string): Record<string, unknown> => ({
	runId: 1,
	totalAdded: 12,
	totalRemoved: 4,
	files: [
		{
			path: `src/module-${tag}.ts`,
			status: "modified",
			additions: 7,
			deletions: 2,
			binary: false,
			patch: diffPatch(`src/module-${tag}.ts`, 1, 8),
		},
		{
			path: `src/new-${tag}.ts`,
			status: "added",
			additions: 5,
			deletions: 0,
			binary: false,
			patch: diffPatch(`src/new-${tag}.ts`, 0, 5),
		},
		{
			path: `assets/big-${tag}.bin`,
			status: "modified",
			additions: 0,
			deletions: 0,
			binary: true,
			unavailable: "Binary file — no text diff.",
		},
		{
			path: `src/too-big-${tag}.ts`,
			status: "modified",
			additions: 900,
			deletions: 900,
			binary: false,
			patchOmitted: true,
			unavailable: "The diff of this file was too large to keep with the chat.",
		},
	],
});

export function buildSmallSession(rootDir: string): SessionManager {
	const sm = SessionManager.create(join(rootDir, "project-small"), join(rootDir, "sessions-small"));
	const stamp = Date.now();
	sm.appendSessionInfo(SMALL_NAME);
	sm.appendModelChange("probe-provider", "probe-model-max");
	sm.appendThinkingLevelChange("high");
	const earlyUser = sm.appendMessage(
		message({
			role: "user",
			content: [
				{
					type: "text",
					text: '第 1 条：请检查 src/module-1.ts 的边界条件。<attachment path="C:/probe/notes.md" />',
				},
				{ type: "image", mimeType: "image/png", data: PNG.red },
			],
			timestamp: stamp,
		}),
	);

	// Branch back to the first user message so the branch_summary marker sits on the
	// final path while the abandoned tail below provides the branch structure.
	sm.branchWithSummary(
		earlyUser,
		`从另一条分支回到主线：那条分支试过整体重写日志层，未采纳。${"补充说明".repeat(120)}`,
		{ dropped: 2 },
		false,
		usage(usageOf(1200, 200, 1400)),
	);

	const editCall = sm.appendMessage(
		message({
			role: "assistant",
			api: "anthropic-messages",
			provider: "probe-provider",
			model: "probe-model-max",
			stopReason: "toolUse",
			timestamp: stamp + 1,
			usage: usageOf(800, 300, 1100),
			content: [
				{ type: "thinking", thinking: `想一下第 1 步：先看边界条件。${"排查边界条件与日志缺口。".repeat(6)}` },
				{
					type: "text",
					text: `### 第 1 轮小结\n\n这一轮调用 \`edit\`：\n\n${tableMd(4)}\n\n\`\`\`ts\n${codeBlock(10)}\n\`\`\``,
				},
				{ type: "toolCall", id: "call-edit-1", name: "edit", arguments: { path: "C:/probe/src/module-1.ts" } },
			],
		}),
	);
	void editCall;
	sm.appendMessage(
		message({
			role: "toolResult",
			toolCallId: "call-edit-1",
			toolName: "edit",
			isError: false,
			timestamp: stamp + 2,
			content: [{ type: "text", text: codeBlock(40) }],
			details: {
				diff: diffPatch("src/module-1.ts", 1, 2),
				files: [{ path: "src/module-1.ts", added: 3, removed: 1, status: "M" }],
			},
		}),
	);
	sm.appendMessage(
		message({
			role: "assistant",
			api: "anthropic-messages",
			provider: "probe-provider",
			model: "probe-model-max",
			stopReason: "toolUse",
			timestamp: stamp + 3,
			usage: usageOf(900, 350, 1250),
			content: [
				{ type: "thinking", thinking: "网页搜索辅助确认。", redacted: true, thinkingSignature: "sig_redacted" },
				{ type: "text", text: `调用 \`web_search\`：\n\n${tableMd(3)}` },
				{ type: "toolCall", id: "call-search-1", name: "web_search", arguments: { query: "边界条件" } },
			],
		}),
	);
	sm.appendMessage(
		message({
			role: "toolResult",
			toolCallId: "call-search-1",
			toolName: "web_search",
			isError: false,
			timestamp: stamp + 4,
			content: [{ type: "text", text: `搜索结果 5 条（web_search 的长输出样本）：\n${codeBlock(50)}` }],
			details: { rounds: 1, resultsReturned: 5, pagesOpened: 2, failures: [], engines: ["bing", "ddg"] },
		}),
	);
	// A lone non-aggregated call (find renders a direct ActionRow, unlike the
	// folded edit/web groups above): keeps ".action-row ≥ 3" true and gives the
	// interaction step a clickable row before the static bash card.
	sm.appendMessage(
		message({
			role: "assistant",
			api: "anthropic-messages",
			provider: "probe-provider",
			model: "probe-model-max",
			stopReason: "toolUse",
			timestamp: stamp + 4,
			usage: usageOf(920, 360, 1280),
			content: [
				{ type: "text", text: `再用 \`find\` 定位同名文件。本地链接探针：[查看应用入口](src/module-1.ts)。` },
				{
					type: "toolCall",
					id: "call-find-1",
					name: "find",
					arguments: { pattern: "module-*.ts", path: "C:/probe/src" },
				},
			],
		}),
	);
	sm.appendMessage(
		message({
			role: "toolResult",
			toolCallId: "call-find-1",
			toolName: "find",
			isError: false,
			timestamp: stamp + 4,
			content: [{ type: "text", text: `src/module-1.ts\nsrc/module-small.ts` }],
			details: { matches: ["src/module-1.ts", "src/module-small.ts"] },
		}),
	);
	sm.appendMessage(
		message({
			role: "bashExecution",
			command: "git status --porcelain  # 小样本",
			output: codeBlock(20).replace(/export const/g, " M src"),
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timedOut: false,
			fullOutputPath: "C:/probe/temporary/bash-1.txt",
			excludeFromContext: false,
			timestamp: stamp + 5,
		}),
	);
	sm.appendCustomEntry("web-git-status", {
		action: "commit",
		ok: true,
		hash: "w25small",
		message: "chore: 小样本改动",
		at: new Date(stamp).toISOString(),
	});
	sm.appendCustomEntry("web-run-changes", runChangesData("small"));
	sm.appendCustomMessageEntry("permission-gate", "扩展提示：小样本请求写入 C:/probe/src/module-1.ts", true, {
		rule: "write",
	});
	sm.appendMessage(
		message({
			role: "assistant",
			api: "anthropic-messages",
			provider: "probe-provider",
			model: "probe-model-max",
			stopReason: "toolUse",
			timestamp: stamp + 6,
			usage: usageOf(950, 380, 1330),
			content: [
				{ type: "text", text: `再调用 \`read\` 核对。` },
				{
					type: "toolCall",
					id: "call-read-1",
					name: "read",
					arguments: { path: "C:/probe/src/module-1.ts", limit: 200 },
				},
			],
		}),
	);
	sm.appendMessage(
		message({
			role: "toolResult",
			toolCallId: "call-read-1",
			toolName: "read",
			isError: true,
			timestamp: stamp + 7,
			content: [
				{ type: "text", text: `读文件输出样本：\n${codeBlock(40)}` },
				{ type: "image", mimeType: "image/png", data: PNG.blue },
			],
			details: { kind: "file", path: "src/module-1.ts", truncated: false, added: 40, removed: 0 },
		}),
	);
	sm.appendCompaction(
		`前情摘要（小样本）：已排查 1 个模块的边界条件，改掉了 pointer-events 与日志缺口。${"细节".repeat(200)}`,
		earlyUser,
		20500,
		{ trigger: "manual", keptEntries: 6 },
		false,
		usage(usageOf(9000, 700, 9700)),
	);
	sm.appendMessage(
		message({
			role: "user",
			content: [
				{ type: "text", text: "最后确认一下。" },
				{ type: "image", mimeType: "image/png", data: PNG.green },
			],
			timestamp: stamp + 8,
		}),
	);
	sm.appendMessage(
		message({
			role: "assistant",
			api: "anthropic-messages",
			provider: "probe-provider",
			model: "probe-model-max",
			stopReason: "stop",
			timestamp: stamp + 9,
			usage: usageOf(200, 640, 840),
			content: [
				{
					type: "text",
					text: [
						"收尾确认：`pointer-events` 改掉后按钮恢复。",
						"",
						tableMd(3),
						"",
						"```ts",
						codeBlock(8),
						"```",
						"",
						"> 收尾引用",
					].join("\n"),
				},
			],
		}),
	);
	// Abandoned side branch, then back to the main path.
	const mainLeaf = sm.getLeafId();
	const summaryEntry = sm.getEntry(earlyUser);
	void summaryEntry;
	sm.branch(earlyUser);
	sm.appendMessage(
		message({
			role: "user",
			content: [{ type: "text", text: `旁支第 0 条：这条分支没有并回主线。${"旁支内容".repeat(30)}` }],
			timestamp: stamp + 10,
		}),
	);
	sm.appendMessage(
		message({
			role: "assistant",
			provider: "probe-provider",
			model: "probe-model-fast",
			stopReason: "stop",
			timestamp: stamp + 11,
			usage: usageOf(10, 20, 30),
			content: [{ type: "text", text: `旁支第 1 条：确认旁支结构。${"旁支内容".repeat(10)}` }],
		}),
	);
	if (mainLeaf) sm.branch(mainLeaf);
	return sm;
}

/** Writes replay HTML into rootDir and returns the file path (extracted from the original beforeAll). */
export function writeExportHtml(rootDir: string, name: string, html: string): string {
	const htmlPath = join(rootDir, name);
	writeFileSync(htmlPath, html, "utf8");
	return htmlPath;
}
