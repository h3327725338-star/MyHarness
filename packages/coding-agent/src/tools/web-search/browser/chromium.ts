import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { BrowserLaunch, PageBridge, PageSnapshot } from "./launch.ts";

/**
 * Chrome and Edge, driven over the DevTools protocol on a pipe (`--remote-debugging-pipe`): no port is opened, so no
 * other program on the machine can reach the browser, and there is no WebDriver in between. The browser runs with
 * MyHarness' own user data directory, never the user's.
 *
 * The bridge answers the same three commands as the Firefox extension (see extension.ts), so everything above it —
 * tabs, challenges, idle shutdown — is shared:
 * - open  {url, selector, timeoutMs, settleMs, foreground, keepOpen} → page snapshot
 * - read  {tabId, selector}                                          → page snapshot
 * - close {tabId}
 */

interface CdpReply {
	id?: number;
	sessionId?: string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string };
}

interface Tab {
	sessionId: string;
	frameId: string;
	/** HTTP status of the tab's last top-level response (0 when unknown). */
	status: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function probeExpression(selector: string): string {
	return `(function(){var s=${JSON.stringify(selector || "")};var ready=false;try{ready=!!(s&&document.querySelector(s));}catch(e){}return {url:location.href,state:document.readyState,ready:ready};})()`;
}
const SNAPSHOT_EXPRESSION =
	"({url:location.href,title:document.title,html:document.documentElement?document.documentElement.outerHTML:''})";

/** DevTools protocol over the browser's pipe: JSON messages separated by a NUL byte. */
export class CdpBridge implements PageBridge {
	private readonly input: Writable;
	private buffer = "";
	private nextId = 1;
	private closed: Error | undefined;
	private readonly pending = new Map<
		number,
		{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
	>();
	private readonly tabs = new Map<string, Tab>();
	/**
	 * Set once at start for a headless browser: its user agent and client hints as the same browser sends them with a
	 * window (headless mode writes "Headless" into both), applied to every tab.
	 */
	private userAgent: Record<string, unknown> | undefined;

	constructor(input: Writable, output: Readable) {
		this.input = input;
		output.setEncoding("utf8");
		output.on("data", (chunk: string) => this.onData(chunk));
		const lost = () => this.failAll(new Error("浏览器关闭了调试连接"));
		output.on("close", lost);
		output.on("error", lost);
		input.on("error", lost);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		while (true) {
			const end = this.buffer.indexOf("\0");
			if (end < 0) return;
			const text = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			let message: CdpReply;
			try {
				message = JSON.parse(text) as CdpReply;
			} catch {
				continue;
			}
			if (typeof message.id === "number") {
				const entry = this.pending.get(message.id);
				if (!entry) continue;
				this.pending.delete(message.id);
				if (message.error) entry.reject(new Error(message.error.message ?? "browser error"));
				else entry.resolve(message.result ?? {});
			} else if (message.method) this.onEvent(message);
		}
	}

	private onEvent(message: CdpReply): void {
		if (message.method !== "Network.responseReceived") return;
		const params = message.params as { type?: string; frameId?: string; response?: { status?: number } } | undefined;
		if (params?.type !== "Document") return;
		for (const tab of this.tabs.values()) {
			if (tab.sessionId === message.sessionId && tab.frameId === params.frameId)
				tab.status = params.response?.status ?? 0;
		}
	}

	private send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		});
	}

	/** Resolves once the browser answers; `headless` browsers get a normal user agent for their tabs. */
	async init(headless: boolean, brand: string): Promise<void> {
		const version = await this.send("Browser.getVersion");
		const userAgent = typeof version.userAgent === "string" ? version.userAgent : "";
		if (!headless || !userAgent.includes("Headless")) return;
		const fullVersion = /Chrome\/([\d.]+)/u.exec(userAgent)?.[1] ?? "";
		const major = fullVersion.split(".")[0] ?? "";
		const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
		this.userAgent = {
			userAgent: userAgent.replace(/Headless/gu, ""),
			userAgentMetadata: {
				brands: [
					{ brand: "Not;A=Brand", version: "99" },
					{ brand, version: major },
					{ brand: "Chromium", version: major },
				],
				fullVersion,
				platform,
				platformVersion: "",
				architecture: process.arch === "arm64" ? "arm" : "x86",
				model: "",
				mobile: false,
			},
		};
	}

	private async evaluate<T>(tab: Tab, expression: string): Promise<T | undefined> {
		try {
			const reply = await this.send("Runtime.evaluate", { expression, returnByValue: true }, tab.sessionId);
			return (reply.result as { value?: T } | undefined)?.value;
		} catch (error) {
			if (this.closed) throw error;
			// The page is navigating (its script context is gone) or cannot be scripted right now.
			return undefined;
		}
	}

	private async snapshot(tabId: string, tab: Tab, ready: boolean): Promise<PageSnapshot> {
		const page = await this.evaluate<{ url: string; title: string; html: string }>(tab, SNAPSHOT_EXPRESSION);
		if (!page) throw new Error("page is not readable");
		return { tabId, url: page.url, title: page.title, html: page.html, ready, status: tab.status };
	}

	private async waitForPage(
		tabId: string,
		tab: Tab,
		selector: string,
		timeoutMs: number,
		settleMs: number,
	): Promise<PageSnapshot> {
		const deadline = Date.now() + timeoutMs;
		let lastUrl = "";
		let completeSince = 0;
		while (Date.now() < deadline) {
			if (!this.tabs.has(tabId)) throw new Error("the tab was closed");
			const info = await this.evaluate<{ url: string; state: string; ready: boolean }>(
				tab,
				probeExpression(selector),
			);
			if (info) {
				// Chrome's own error page (connection refused, DNS failure, ...).
				if (info.url.startsWith("chrome-error://")) throw new Error("page load failed");
				if (info.ready) return this.snapshot(tabId, tab, true);
				if (info.state === "complete" && info.url === lastUrl && info.url !== "about:blank") {
					if (!completeSince) completeSince = Date.now();
					if (Date.now() - completeSince >= settleMs) return this.snapshot(tabId, tab, false);
				} else completeSince = 0;
				lastUrl = info.url;
			}
			await sleep(250);
		}
		try {
			return await this.snapshot(tabId, tab, false);
		} catch {
			throw new Error("page load timed out");
		}
	}

	private async open(command: Record<string, unknown>): Promise<PageSnapshot> {
		const foreground = command.foreground === true;
		const created = await this.send("Target.createTarget", { url: "about:blank", background: !foreground });
		const tabId = String(created.targetId);
		try {
			const attached = await this.send("Target.attachToTarget", { targetId: tabId, flatten: true });
			const sessionId = String(attached.sessionId);
			await this.send("Page.enable", {}, sessionId);
			await this.send("Network.enable", {}, sessionId);
			const tree = await this.send("Page.getFrameTree", {}, sessionId);
			const frameId = (tree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id ?? tabId;
			const tab: Tab = { sessionId, frameId, status: 0 };
			this.tabs.set(tabId, tab);
			if (this.userAgent) await this.send("Emulation.setUserAgentOverride", this.userAgent, sessionId);
			if (foreground) await this.send("Page.bringToFront", {}, sessionId).catch(() => {});
			const navigated = await this.send("Page.navigate", { url: String(command.url) }, sessionId);
			// A download or an aborted navigation reports an error text too; only a failed load without a page counts.
			if (
				typeof navigated.errorText === "string" &&
				navigated.errorText &&
				navigated.errorText !== "net::ERR_ABORTED"
			) {
				throw new Error(`page load failed: ${navigated.errorText}`);
			}
			return await this.waitForPage(
				tabId,
				tab,
				String(command.selector ?? ""),
				Number(command.timeoutMs),
				Number(command.settleMs),
			);
		} finally {
			if (command.keepOpen !== true || !this.tabs.has(tabId)) await this.closeTab(tabId);
		}
	}

	private async closeTab(tabId: string): Promise<void> {
		this.tabs.delete(tabId);
		await this.send("Target.closeTarget", { targetId: tabId }).catch(() => {});
	}

	async command<T>(command: Record<string, unknown>, timeoutMs: number): Promise<T> {
		const run = async (): Promise<unknown> => {
			if (command.type === "open") return this.open(command);
			if (command.type === "read") {
				const tabId = String(command.tabId);
				const tab = this.tabs.get(tabId);
				if (!tab) throw new Error("the tab was closed");
				const info = await this.evaluate<{ ready: boolean }>(tab, probeExpression(String(command.selector ?? "")));
				return this.snapshot(tabId, tab, !!info?.ready);
			}
			if (command.type === "close") {
				await this.closeTab(String(command.tabId));
				return {};
			}
			throw new Error(`unknown command ${String(command.type)}`);
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return (await Promise.race([
				run(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("浏览器没有在规定时间内完成操作")), timeoutMs);
				}),
			])) as T;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Chrome keeps new cookies in memory for a while; a browser that is killed loses them, one that is asked to quit saves them. */
	async quit(): Promise<void> {
		await this.send("Browser.close");
	}

	failAll(error: Error): void {
		this.closed ??= error;
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			entry.reject(error);
		}
	}

	close(): void {
		this.failAll(new Error("浏览器已关闭"));
		this.input.destroy();
	}
}

/**
 * Start Chrome or Edge with the dedicated user data directory. The flags keep the first-run screens away and stop the
 * page from being told it is automated (which a debugging pipe and headless mode would otherwise do).
 */
export function launchChromium(options: {
	executable: string;
	profileDir: string;
	headless: boolean;
	/** The brand the browser names itself in its client hints: "Google Chrome" or "Microsoft Edge". */
	brand: string;
}): BrowserLaunch {
	mkdirSync(options.profileDir, { recursive: true });
	const args = [
		`--user-data-dir=${options.profileDir}`,
		"--remote-debugging-pipe",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-default-apps",
		"--disable-sync",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=Translate,msEdgeWelcomePage,EdgeFirstRunExperience",
		"--window-size=1280,900",
		...(options.headless ? ["--headless=new"] : []),
		"about:blank",
	];
	// The browser reads commands from file descriptor 3 and writes replies to 4.
	const child: ChildProcess = spawn(options.executable, args, {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		windowsHide: options.headless,
	});
	const bridge = new CdpBridge(child.stdio[3] as Writable, child.stdio[4] as Readable);
	return { child, bridge, ready: () => bridge.init(options.headless, options.brand) };
}
