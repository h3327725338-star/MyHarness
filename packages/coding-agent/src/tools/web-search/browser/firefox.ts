import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { delimiter, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../../config.ts";
import { abortError, WebSearchError } from "../errors.ts";
import {
	type BrowserChallengeRequest,
	type BrowserPageRequest,
	type BrowserState,
	type BrowserTransport,
	browserUnavailable,
	type TransportPage,
} from "../transport.ts";
import { launchChromium } from "./chromium.ts";
import { writeExtension } from "./extension.ts";
import { keepChallengeForeground } from "./foreground.ts";
import { type DailyCookies, findDailyCookies, forgetCookieImport, importDailyCookiesOnce } from "./import-cookies.ts";
import type { BrowserLaunch, PageBridge, PageSnapshot } from "./launch.ts";
import { installTemporaryAddon } from "./rdp.ts";

/**
 * Real-browser transport backed by a browser that is installed on this computer: Firefox, Chrome or Edge.
 *
 * - Runs the browser with MyHarness' own profile (never the user's), so cookies,
 *   consent choices, logins and solved CAPTCHAs persist across searches and
 *   MyHarness restarts, isolated from the user's normal browsing.
 * - Normal loads use a headless browser. Only when a site demands a
 *   CAPTCHA/consent/login step (and a user is present) is a visible window opened.
 * - Launched lazily on first use, shut down after a few idle minutes and when
 *   MyHarness exits. A crashed browser fails the pending requests with a clear
 *   error; the next request starts a new one.
 * - One MyHarness process owns a profile at a time (file lock).
 *
 * Firefox is driven through a small extension (extension.ts), Chrome and Edge through the DevTools pipe
 * (chromium.ts); both answer the same commands, so everything in this file is shared.
 */

/** The browsers MyHarness can drive, in the order they are tried when the setting is "auto". */
export const BROWSER_KINDS = ["firefox", "chrome", "edge"] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];
export const BROWSER_LABELS: Record<BrowserKind, string> = { firefox: "Firefox", chrome: "Chrome", edge: "Edge" };

export const FIREFOX_LIMITS = {
	launchTimeoutMs: 30_000,
	pageTimeoutMs: 25_000,
	/** A loaded page without the results selector counts as final after this quiet period. */
	settleMs: 2_500,
	idleShutdownMs: 3 * 60_000,
	/** How long a user gets to pass a CAPTCHA in the visible window. */
	challengeTimeoutMs: 3 * 60_000,
	challengePollMs: 1_000,
	/** A page that just got past its challenge is read again after this pause, so what is returned has finished loading. */
	challengeSettleMs: 1_500,
	/** Tabs loading at the same time. */
	maxTabs: 3,
	/** How long the bridge holds a poll open with no command. */
	pollHoldMs: 20_000,
} as const;

/** Prefs for the dedicated profile: quiet startup, and the debugger server used once to install the extension. */
const PROFILE_PREFS: Record<string, boolean | number | string> = {
	"devtools.debugger.remote-enabled": true,
	"devtools.debugger.prompt-connection": false,
	"devtools.chrome.enabled": true,
	"browser.shell.checkDefaultBrowser": false,
	"browser.startup.homepage_override.mstone": "ignore",
	"startup.homepage_welcome_url": "about:blank",
	"startup.homepage_welcome_url.additional": "",
	"browser.startup.page": 0,
	"browser.aboutwelcome.enabled": false,
	"datareporting.policy.dataSubmissionEnabled": false,
	"datareporting.policy.firstRunURL": "",
	"toolkit.telemetry.reportingpolicy.firstRun": false,
	"browser.sessionstore.resume_from_crash": false,
	"browser.tabs.warnOnClose": false,
	"browser.tabs.closeWindowWithLastTab": false,
	"extensions.update.enabled": false,
	"media.autoplay.default": 5,
	"permissions.default.desktop-notification": 2,
	"browser.translations.automaticallyPopup": false,
};

/** Where Firefox usually lives. `MYHARNESS_FIREFOX_PATH` overrides the search. */
export function findFirefoxExecutable(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	const override = env.MYHARNESS_FIREFOX_PATH?.trim();
	if (override) return exists(override) ? override : undefined;
	const candidates: string[] = [];
	if (platform === "win32") {
		for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
			if (base) candidates.push(join(base, "Mozilla Firefox", "firefox.exe"));
		}
	} else if (platform === "darwin") {
		candidates.push("/Applications/Firefox.app/Contents/MacOS/firefox");
	}
	const binary = platform === "win32" ? "firefox.exe" : "firefox";
	for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) if (dir) candidates.push(join(dir, binary));
	return candidates.find((candidate) => exists(candidate));
}

/** Install locations of Chrome and Edge, below a base folder such as Program Files. */
const CHROMIUM_LOCATIONS: Record<
	"chrome" | "edge",
	{ windows: string[]; mac: string; binaries: string[]; env: string }
> = {
	chrome: {
		windows: ["Google", "Chrome", "Application", "chrome.exe"],
		mac: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		binaries: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
		env: "MYHARNESS_CHROME_PATH",
	},
	edge: {
		windows: ["Microsoft", "Edge", "Application", "msedge.exe"],
		mac: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		binaries: ["microsoft-edge", "microsoft-edge-stable"],
		env: "MYHARNESS_EDGE_PATH",
	},
};

/**
 * Where a browser of this kind is installed, or undefined. `MYHARNESS_FIREFOX_PATH`, `MYHARNESS_CHROME_PATH` and
 * `MYHARNESS_EDGE_PATH` override the search for their browser.
 */
export function findBrowserExecutable(
	kind: BrowserKind,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	if (kind === "firefox") return findFirefoxExecutable(env, platform, exists);
	const location = CHROMIUM_LOCATIONS[kind];
	const override = env[location.env]?.trim();
	if (override) return exists(override) ? override : undefined;
	const candidates: string[] = [];
	if (platform === "win32") {
		for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
			if (base) candidates.push(join(base, ...location.windows));
		}
		const binary = location.windows.at(-1)!;
		for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) if (dir) candidates.push(join(dir, binary));
	} else {
		if (platform === "darwin") candidates.push(location.mac);
		for (const dir of (env.PATH ?? "").split(delimiter)) {
			if (dir) for (const binary of location.binaries) candidates.push(join(dir, binary));
		}
	}
	return candidates.find((candidate) => exists(candidate));
}

/** The supported browsers that are installed on this computer, in the order "auto" tries them. */
export function detectInstalledBrowsers(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
): Array<{ kind: BrowserKind; label: string; executable: string }> {
	return BROWSER_KINDS.flatMap((kind) => {
		const executable = findBrowserExecutable(kind, env, platform, exists);
		return executable ? [{ kind, label: BROWSER_LABELS[kind], executable }] : [];
	});
}

interface BridgeReply {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

interface PendingCommand {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Loopback HTTP endpoint the Firefox extension long-polls for commands. */
class Bridge implements PageBridge {
	readonly token = randomBytes(24).toString("hex");
	private server: Server | undefined;
	private readonly queue: Array<Record<string, unknown>> = [];
	private readonly pending = new Map<number, PendingCommand>();
	private heldPoll: ((command: Record<string, unknown>) => void) | undefined;
	private nextId = 1;
	private connectedWaiters: Array<() => void> = [];
	connected = false;

	async listen(): Promise<number> {
		this.server = createServer((request, response) => this.onRequest(request, response));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(0, "127.0.0.1", () => resolve());
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("bridge has no port");
		return address.port;
	}

	private onRequest(request: IncomingMessage, response: ServerResponse): void {
		const prefix = `/${this.token}/`;
		if (!request.url?.startsWith(prefix)) {
			response.writeHead(403).end();
			return;
		}
		const action = request.url.slice(prefix.length);
		if (action === "poll" && request.method === "GET") {
			if (!this.connected) {
				this.connected = true;
				for (const waiter of this.connectedWaiters.splice(0)) waiter();
			}
			const send = (command: Record<string, unknown>) => {
				response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
				response.end(JSON.stringify(command));
			};
			const queued = this.queue.shift();
			if (queued) {
				send(queued);
				return;
			}
			const timer = setTimeout(() => {
				if (this.heldPoll === hold) this.heldPoll = undefined;
				response.writeHead(204).end();
			}, FIREFOX_LIMITS.pollHoldMs);
			const hold = (command: Record<string, unknown>) => {
				clearTimeout(timer);
				send(command);
			};
			this.heldPoll = hold;
			response.on("close", () => {
				clearTimeout(timer);
				if (this.heldPoll === hold) this.heldPoll = undefined;
			});
			return;
		}
		if (action === "result" && request.method === "POST") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				response.writeHead(204).end();
				let reply: BridgeReply;
				try {
					reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeReply;
				} catch {
					return;
				}
				const entry = this.pending.get(reply.id);
				if (!entry) return;
				this.pending.delete(reply.id);
				clearTimeout(entry.timer);
				if (reply.ok) entry.resolve(reply.result);
				else entry.reject(new Error(reply.error ?? "Firefox 扩展返回了错误"));
			});
			return;
		}
		response.writeHead(404).end();
	}

	waitConnected(timeoutMs: number): Promise<void> {
		if (this.connected) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Firefox 扩展没有连上 MyHarness")), timeoutMs);
			this.connectedWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	command<T>(command: Record<string, unknown>, timeoutMs: number): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const index = this.queue.findIndex((item) => item.id === id);
				if (index >= 0) this.queue.splice(index, 1);
				reject(new Error("Firefox 没有在规定时间内完成操作"));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			const message = { ...command, id };
			const hold = this.heldPoll;
			if (hold) {
				this.heldPoll = undefined;
				hold(message);
			} else this.queue.push(message);
		});
	}

	failAll(error: Error): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
			this.pending.delete(id);
		}
		this.queue.length = 0;
	}

	async quit(): Promise<void> {
		if (!this.connected) throw new Error("not connected");
		await this.command({ type: "quit" }, 3_000);
	}

	close(): void {
		this.server?.close();
		this.server?.closeAllConnections?.();
	}
}

interface Session {
	child: ChildProcess;
	bridge: PageBridge;
	headless: boolean;
	exited: boolean;
	exitError?: Error;
	/** Resolves once the Firefox process is gone (and no longer holds the profile). */
	exit: Promise<void>;
}

/** How long a stopped browser gets to exit before we stop waiting for it. */
const EXIT_WAIT_MS = 15_000;
/** How long a browser that was asked to quit gets to do so (and save its cookies) before its process is ended. */
const QUIT_WAIT_MS = 5_000;

export interface LocalBrowserOptions {
	/** Which browser to drive. Defaults to Firefox. */
	kind?: BrowserKind;
	/** Holds `profile/`, `extension/`, the pid file and the lock. Defaults to <agent dir>/web-search/<kind>. */
	rootDir?: string;
	executable?: string;
	/** Injectable for tests. */
	findExecutable?: () => string | undefined;
	/** Where the user's daily cookies of this browser are. Injectable for tests; defaults to the real daily profile. */
	findDailyCookies?: () => DailyCookies | undefined;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

/** True only for a live browser started with our profile, so a reused pid never hits the user's own browser. */
function isOurBrowser(pid: number, profileDir: string): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const commandLine =
		process.platform === "win32"
			? spawnSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
					],
					{ encoding: "utf8", windowsHide: true, timeout: 15_000 },
				).stdout
			: spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout;
	const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
	return (
		/firefox|chrome|msedge|chromium|edge/iu.test(commandLine ?? "") &&
		normalize(commandLine ?? "").includes(normalize(profileDir))
	);
}

function killTree(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
}

/** Start Firefox with the dedicated profile and the bridge extension. */
async function launchFirefox(options: {
	executable: string;
	profileDir: string;
	extensionDir: string;
	headless: boolean;
}): Promise<BrowserLaunch> {
	mkdirSync(options.profileDir, { recursive: true });
	writeFileSync(
		join(options.profileDir, "user.js"),
		`${Object.entries(PROFILE_PREFS)
			.map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
			.join("\n")}\n`,
	);
	const bridge = new Bridge();
	const bridgePort = await bridge.listen();
	writeExtension(options.extensionDir, { port: bridgePort, token: bridge.token });
	const debuggerPort = await freePort();
	const args = [
		"-profile",
		options.profileDir,
		"-no-remote",
		"-new-instance",
		// On Windows firefox.exe is a launcher that starts the real browser and exits;
		// this keeps it alive until the browser exits, so exit and kill track the browser.
		"-wait-for-browser",
		"--start-debugger-server",
		String(debuggerPort),
		...(options.headless ? ["-headless"] : []),
		"about:blank",
	];
	const child = spawn(options.executable, args, { stdio: "ignore", windowsHide: options.headless });
	return {
		child,
		bridge,
		ready: async ({ timeoutMs, signal, isAlive }) => {
			await installTemporaryAddon(debuggerPort, options.extensionDir, { timeoutMs, signal, isAlive });
			await bridge.waitConnected(timeoutMs);
		},
	};
}

export class LocalBrowser implements BrowserTransport {
	readonly kind: BrowserKind;
	/** "Firefox", "Chrome" or "Edge", as messages name this browser. */
	readonly label: string;
	/**
	 * "Use My Browser's Cookies": before the browser starts, copy the cookies of the user's daily profile of this
	 * browser into MyHarness' profile (once, see import-cookies.ts). Set by whoever knows the setting.
	 */
	useDailyCookies = false;
	/** Why the daily cookies could not be imported at the last start, when they could not. */
	private cookieNote: string | undefined;
	private readonly rootDir: string;
	private readonly findExecutable: () => string | undefined;
	private readonly findDailyCookies: () => DailyCookies | undefined;
	private executable: string | undefined;
	private session: Promise<Session> | undefined;
	private releaseLock: (() => Promise<void>) | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private activeTabs = 0;
	private readonly tabWaiters: Array<() => void> = [];
	private busy = 0;
	private challenge: Promise<unknown> | undefined;
	/** The running Firefox, kept synchronously for cleanup on process exit. */
	private currentChild: ChildProcess | undefined;
	private readonly onProcessExit = () => {
		if (this.currentChild?.pid && this.currentChild.exitCode === null) killTree(this.currentChild.pid);
		rmSync(this.pidFile, { force: true });
	};

	constructor(options: LocalBrowserOptions = {}) {
		this.kind = options.kind ?? "firefox";
		this.label = BROWSER_LABELS[this.kind];
		this.rootDir = options.rootDir ?? join(getAgentDir(), "web-search", this.kind);
		this.executable = options.executable;
		this.findExecutable = options.findExecutable ?? (() => findBrowserExecutable(this.kind));
		this.findDailyCookies = options.findDailyCookies ?? (() => findDailyCookies(this.kind));
	}

	private get pidFile(): string {
		return join(this.rootDir, `${this.kind}.pid`);
	}

	state(): BrowserState {
		this.executable ??= this.findExecutable();
		if (!this.executable) {
			return {
				available: false,
				reason: `没有找到 ${this.label}。安装 ${this.label}（或设置 MYHARNESS_${this.kind.toUpperCase()}_PATH）后即可使用浏览器兜底。`,
			};
		}
		return {
			available: true,
			executable: this.executable,
			label: this.label,
			...(this.useDailyCookies && this.cookieNote ? { note: this.cookieNote } : {}),
		};
	}

	/** Headless background load of one page. */
	async load(request: BrowserPageRequest, signal?: AbortSignal): Promise<TransportPage> {
		// While the user is solving a challenge, the visible browser serves everything.
		if (this.challenge) await this.challenge.catch(() => {});
		const release = await this.acquireTab(signal);
		this.busy += 1;
		try {
			const session = await this.ensureSession({ headless: undefined, signal });
			const snapshot = await this.withAbort(
				session.bridge.command<PageSnapshot>(
					{
						type: "open",
						url: request.url,
						selector: request.readySelector,
						timeoutMs: FIREFOX_LIMITS.pageTimeoutMs,
						settleMs: FIREFOX_LIMITS.settleMs,
					},
					FIREFOX_LIMITS.pageTimeoutMs + 10_000,
				),
				session,
				signal,
				request.label,
			);
			return this.toPage(snapshot);
		} finally {
			this.busy -= 1;
			release();
			this.scheduleIdleShutdown();
		}
	}

	async solveChallenge(request: BrowserChallengeRequest, signal?: AbortSignal): Promise<TransportPage> {
		// One visible challenge at a time; others wait and then reuse the solved session.
		while (this.challenge) await this.challenge.catch(() => {});
		const run = this.runChallenge(request, signal);
		this.challenge = run;
		try {
			return await run;
		} finally {
			this.challenge = undefined;
			// Next background load starts headless again with the saved cookies.
			await this.shutdown();
		}
	}

	private async runChallenge(request: BrowserChallengeRequest, signal?: AbortSignal): Promise<TransportPage> {
		const session = await this.ensureSession({ headless: false, signal });
		const releaseForeground = keepChallengeForeground(session.child.pid);
		try {
			const opened = await this.withAbort(
				session.bridge.command<PageSnapshot>(
					{
						type: "open",
						url: request.url,
						selector: request.readySelector,
						timeoutMs: FIREFOX_LIMITS.pageTimeoutMs,
						settleMs: FIREFOX_LIMITS.settleMs,
						foreground: true,
						keepOpen: true,
					},
					FIREFOX_LIMITS.pageTimeoutMs + 10_000,
				),
				session,
				signal,
				request.label,
			);
			const deadline = Date.now() + FIREFOX_LIMITS.challengeTimeoutMs;
			try {
				let page = this.toPage(opened);
				while (!request.isSolved(page)) {
					if (Date.now() > deadline) {
						throw new WebSearchError(
							"challenge_required",
							`等待你在 ${this.label} 窗口中完成 ${request.label} 的验证超时（${FIREFOX_LIMITS.challengeTimeoutMs / 60_000} 分钟）。`,
						);
					}
					await this.sleep(FIREFOX_LIMITS.challengePollMs, signal);
					let snapshot: PageSnapshot;
					try {
						snapshot = await this.withAbort(
							session.bridge.command<PageSnapshot>(
								{ type: "read", tabId: opened.tabId, selector: request.readySelector },
								10_000,
							),
							session,
							signal,
							request.label,
						);
					} catch (error) {
						if (error instanceof WebSearchError && error.code === "aborted") throw error;
						throw new WebSearchError(
							"challenge_required",
							`${request.label} 验证页面被关闭或无法读取，验证没有完成。`,
							{ cause: error },
						);
					}
					page = this.toPage(snapshot);
					// The page that just got through may still be loading: what is returned is read once it has settled.
					if (request.isSolved(page)) {
						await this.sleep(FIREFOX_LIMITS.challengeSettleMs, signal);
						const settled = await session.bridge
							.command<PageSnapshot>(
								{ type: "read", tabId: opened.tabId, selector: request.readySelector },
								10_000,
							)
							.catch(() => undefined);
						if (settled) page = this.toPage(settled);
					}
				}
				return page;
			} finally {
				if (!session.exited) {
					await session.bridge.command({ type: "close", tabId: opened.tabId }, 5_000).catch(() => {});
				}
			}
		} finally {
			releaseForeground();
		}
	}

	/** "headless" / "visible" while the browser runs, undefined otherwise. */
	async runningMode(): Promise<"headless" | "visible" | undefined> {
		const session = await this.session?.catch(() => undefined);
		if (!session || session.exited) return undefined;
		return session.headless ? "headless" : "visible";
	}

	/** Stop the browser and release the profile. Safe to call at any time. */
	async shutdown(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		const current = this.session;
		this.session = undefined;
		if (current) {
			const session = await current.catch(() => undefined);
			if (session) await this.stopSession(session, new Error(`${this.label} 已关闭`));
		}
		await this.unlock();
	}

	private toPage(snapshot: PageSnapshot): TransportPage {
		return {
			status: snapshot.status || 200,
			url: snapshot.url,
			text: snapshot.html,
			headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
			via: "browser",
			ready: snapshot.ready,
		};
	}

	private async withAbort<T>(
		promise: Promise<T>,
		session: Session,
		signal: AbortSignal | undefined,
		label: string,
	): Promise<T> {
		const aborted = abortError(signal);
		if (aborted) throw aborted;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				promise.catch((error: unknown) => {
					if (session.exited) {
						throw browserUnavailable(
							`${this.label} 意外退出，${label} 页面没有读完。${session.exitError?.message ?? ""}`,
						);
					}
					throw new WebSearchError(
						"unavailable",
						`${this.label} 读取 ${label} 页面失败：${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}),
				new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(abortError(signal));
					signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	private sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(abortError(signal));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async acquireTab(signal: AbortSignal | undefined): Promise<() => void> {
		while (this.activeTabs >= FIREFOX_LIMITS.maxTabs) {
			await new Promise<void>((resolve, reject) => {
				const aborted = abortError(signal);
				if (aborted) {
					reject(aborted);
					return;
				}
				const wake = () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => {
					const index = this.tabWaiters.indexOf(wake);
					if (index >= 0) this.tabWaiters.splice(index, 1);
					reject(abortError(signal));
				};
				this.tabWaiters.push(wake);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		this.activeTabs += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeTabs -= 1;
			this.tabWaiters.shift()?.();
		};
	}

	private scheduleIdleShutdown(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (this.busy === 0 && !this.challenge) void this.shutdown();
		}, FIREFOX_LIMITS.idleShutdownMs);
		this.idleTimer.unref?.();
	}

	/** Reuse the running browser, or start one. `headless: undefined` accepts either mode. */
	private async ensureSession(options: { headless: boolean | undefined; signal?: AbortSignal }): Promise<Session> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.session) {
			const current = await this.session.catch(() => undefined);
			if (current && !current.exited && (options.headless === undefined || current.headless === options.headless)) {
				return current;
			}
			if (current && !current.exited) {
				// Mode change (headless → visible for a challenge) needs a restart; the
				// profile keeps the cookies. Let background loads that already run finish.
				while (this.busy > 0) await this.sleep(200, options.signal);
			}
			await this.shutdown();
		}
		const starting = this.start(options.headless ?? true, options.signal);
		this.session = starting;
		try {
			return await starting;
		} catch (error) {
			if (this.session === starting) this.session = undefined;
			await this.unlock();
			throw error;
		}
	}

	private async lock(): Promise<void> {
		if (this.releaseLock) return;
		mkdirSync(this.rootDir, { recursive: true });
		try {
			this.releaseLock = await lockfile.lock(this.rootDir, {
				realpath: false,
				stale: 30_000,
				update: 10_000,
				retries: 0,
				onCompromised: () => {
					this.releaseLock = undefined;
				},
			});
		} catch {
			throw browserUnavailable(
				`另一个 MyHarness 进程正在使用 ${this.label} 搜索配置文件，本进程暂时不能使用浏览器兜底。`,
			);
		}
	}

	private async unlock(): Promise<void> {
		const release = this.releaseLock;
		this.releaseLock = undefined;
		await release?.().catch(() => {});
	}

	private async start(headless: boolean, signal: AbortSignal | undefined): Promise<Session> {
		const state = this.state();
		if (!state.available) throw browserUnavailable(state.reason);
		await this.lock();
		const profileDir = join(this.rootDir, "profile");
		const pidFile = this.pidFile;
		// A browser left behind by a MyHarness that crashed still holds the profile.
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (Number.isSafeInteger(pid) && pid > 0 && isOurBrowser(pid, profileDir)) killTree(pid);
			rmSync(pidFile, { force: true });
		}
		if (this.useDailyCookies) {
			const imported = importDailyCookiesOnce(this.label, this.rootDir, profileDir, this.findDailyCookies());
			this.cookieNote = imported.ok ? undefined : imported.error;
		} else {
			forgetCookieImport(this.rootDir);
			this.cookieNote = undefined;
		}
		const launch =
			this.kind === "firefox"
				? await launchFirefox({
						executable: state.executable,
						profileDir,
						extensionDir: join(this.rootDir, "extension"),
						headless,
					})
				: launchChromium({
						executable: state.executable,
						profileDir,
						headless,
						brand: this.kind === "edge" ? "Microsoft Edge" : "Google Chrome",
					});
		const { child, bridge } = launch;
		let markExited: () => void = () => {};
		const session: Session = {
			child,
			bridge,
			headless,
			exited: false,
			exit: new Promise<void>((resolve) => {
				markExited = resolve;
			}),
		};
		const spawnFailed = new Promise<never>((_resolve, reject) => {
			child.once("error", (error) => {
				session.exited = true;
				session.exitError = error;
				markExited();
				reject(browserUnavailable(`无法启动 ${this.label}：${error.message}`));
			});
		});
		spawnFailed.catch(() => {});
		child.once("exit", (code) => {
			session.exited = true;
			session.exitError ??= new Error(`退出码 ${code ?? "unknown"}`);
			markExited();
			bridge.failAll(browserUnavailable(`${this.label} 意外退出。`));
			bridge.close();
			process.off("exit", this.onProcessExit);
			rmSync(pidFile, { force: true });
			const tracked = this.session;
			tracked?.then(
				(current) => {
					if (current === session && this.session === tracked) {
						this.session = undefined;
						void this.unlock();
					}
				},
				() => {},
			);
		});
		this.currentChild = child;
		if (child.pid) writeFileSync(pidFile, String(child.pid));
		process.on("exit", this.onProcessExit);
		try {
			await Promise.race([
				launch.ready({
					timeoutMs: FIREFOX_LIMITS.launchTimeoutMs,
					signal,
					isAlive: () => !session.exited,
				}),
				spawnFailed,
			]);
		} catch (error) {
			await this.stopSession(session, error as Error);
			if (error instanceof WebSearchError) throw error;
			throw browserUnavailable(
				`${this.label} 启动后没能接入 MyHarness：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return session;
	}

	/** Stop one browser and wait until it has exited, so the profile is free for the next start. */
	private async stopSession(session: Session, reason: Error): Promise<void> {
		if (!session.exited && session.bridge.quit) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				session.bridge.quit().then(
					() => session.exit,
					() => {},
				),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, QUIT_WAIT_MS);
				}),
			]);
			if (timer) clearTimeout(timer);
		}
		session.bridge.failAll(reason);
		session.bridge.close();
		if (!session.exited && session.child.pid) killTree(session.child.pid);
		process.off("exit", this.onProcessExit);
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			session.exit,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, EXIT_WAIT_MS);
			}),
		]);
		if (timer) clearTimeout(timer);
	}
}

/** The Firefox transport under its earlier name. */
export class FirefoxBrowser extends LocalBrowser {
	constructor(options: Omit<LocalBrowserOptions, "kind"> = {}) {
		super({ ...options, kind: "firefox" });
	}
}
export type FirefoxBrowserOptions = Omit<LocalBrowserOptions, "kind">;

const sharedBrowsers = new Map<BrowserKind, LocalBrowser>();

/** The process-wide transport of one browser (one profile, one browser process per kind). */
export function getSharedBrowser(kind: BrowserKind): LocalBrowser {
	let browser = sharedBrowsers.get(kind);
	if (!browser) {
		browser = kind === "firefox" ? new FirefoxBrowser() : new LocalBrowser({ kind });
		sharedBrowsers.set(kind, browser);
	}
	return browser;
}

/** The process-wide Firefox transport. */
export function getSharedFirefoxBrowser(): FirefoxBrowser {
	return getSharedBrowser("firefox") as FirefoxBrowser;
}
