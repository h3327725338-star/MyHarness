import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/config/settings/index.ts";
import type { WebSearchSettings } from "../src/config/settings/types.ts";
import { CdpBridge } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers, findBrowserExecutable } from "../src/tools/web-search/browser/firefox.ts";
import {
	findDailyCookies,
	forgetCookieImport,
	importDailyCookiesOnce,
} from "../src/tools/web-search/browser/import-cookies.ts";
import type { PageSnapshot } from "../src/tools/web-search/browser/launch.ts";
import { WebSearchCache } from "../src/tools/web-search/cache.ts";
import { WebSearchError } from "../src/tools/web-search/errors.ts";
import { detectAccessWall } from "../src/tools/web-search/page.ts";
import { WebSearchService } from "../src/tools/web-search/service.ts";
import { createWebFetchToolDefinition } from "../src/tools/web-search/tool.ts";
import type { BrowserChallengeRequest, BrowserTransport, TransportPage } from "../src/tools/web-search/transport.ts";

const article = (title: string, body: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
const loginPage =
	'<html><head><title>Sign in</title></head><body><form><input type="text" name="user"><input type="password" name="pass"></form></body></html>';
const challengePage =
	'<html><head><title>Just a moment...</title></head><body><div id="cf-challenge">Verifying you are human.</div></body></html>';

function html(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function browserPage(url: string, text: string, status = 200): TransportPage {
	return { status, url, text, headers: new Headers(), via: "browser", ready: false };
}

interface FakeBrowserOptions {
	available?: boolean;
	label?: string;
	note?: string;
	/** What the headless browser shows for a URL. */
	load: (url: string) => TransportPage;
	/** The pages the visible window goes through while the person works on it; the first solved one is returned. */
	challenge?: (url: string) => TransportPage[] | Error;
}

function fakeBrowser(options: FakeBrowserOptions) {
	const loads: string[] = [];
	const challenges: string[] = [];
	const browser: BrowserTransport = {
		state: () =>
			options.available === false
				? { available: false, reason: "没有找到可用的浏览器。" }
				: { available: true, executable: "chrome.exe", label: options.label ?? "Chrome", note: options.note },
		load: async (request) => {
			loads.push(request.url);
			return options.load(request.url);
		},
		solveChallenge: async (request: BrowserChallengeRequest) => {
			challenges.push(request.url);
			const steps = options.challenge?.(request.url) ?? new WebSearchError("challenge_required", "没有人处理。");
			if (steps instanceof Error) throw steps;
			const solved = steps.find((page) => request.isSolved(page));
			if (!solved) throw new WebSearchError("challenge_required", "等待你在 Chrome 窗口中完成验证超时（3 分钟）。");
			return solved;
		},
	};
	return { browser, loads, challenges };
}

function createService(
	routes: Record<string, () => Response>,
	browser: BrowserTransport | null,
	options: { settings?: WebSearchSettings; interactive?: boolean; now?: () => number } = {},
) {
	const settingsManager = SettingsManager.inMemory({
		webSearch: { enabled: true, browserFallback: true, ...options.settings },
	});
	const calls: string[] = [];
	const service = new WebSearchService({
		settings: settingsManager,
		fetchImpl: async (input) => {
			const url = new URL(String(input));
			calls.push(url.href);
			const route = routes[url.hostname];
			if (!route) throw new TypeError("fetch failed");
			return route();
		},
		lookup: async (host) => (host === "intranet.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
		cache: new WebSearchCache(undefined),
		browser,
		interactiveChallenges: () => options.interactive ?? false,
		now: options.now,
	});
	return { service, calls };
}

describe("what counts as a wall instead of a page", () => {
	it("recognises robot checks, logins, consent pages and refusals, and leaves real pages alone", () => {
		expect(detectAccessWall(challengePage, 403, "https://site.example/a")).toMatchObject({ kind: "captcha" });
		expect(detectAccessWall(challengePage, 200, "https://site.example/a")).toMatchObject({ kind: "captcha" });
		expect(detectAccessWall(loginPage, 200, "https://site.example/login")).toMatchObject({ kind: "login" });
		expect(
			detectAccessWall("<html><body>Before you continue</body></html>", 200, "https://consent.site.example/"),
		).toMatchObject({ kind: "consent" });
		expect(detectAccessWall("<html><body>Forbidden</body></html>", 403, "https://site.example/")).toMatchObject({
			kind: "blocked",
			reason: expect.stringContaining("403"),
		});
		expect(detectAccessWall("<html><body>slow down</body></html>", 429, "https://site.example/")).toMatchObject({
			kind: "blocked",
			reason: expect.stringContaining("429"),
		});
		const long = "A real article about CAPTCHA widgets and passwords. ".repeat(60);
		expect(detectAccessWall(article("How logins work", long), 200, "https://site.example/")).toBeUndefined();
		// A long page with a login box in its header, or with a CAPTCHA widget on it, is still the page.
		expect(
			detectAccessWall(
				`<html><body><input type="password"><div class="g-recaptcha"></div><p>${long}</p></body></html>`,
				200,
				"https://site.example/",
			),
		).toBeUndefined();
		// A short page that merely carries a CAPTCHA widget (a contact form) is not a robot check.
		expect(
			detectAccessWall(
				`<html><body><p>${"Contact us with this form. ".repeat(30)}</p><div class="g-recaptcha"></div></body></html>`,
				200,
				"https://site.example/",
			),
		).toBeUndefined();
		expect(detectAccessWall("<html><body>Not found</body></html>", 404, "https://site.example/")).toBeUndefined();
	});
});

describe("reading a page that refuses plain requests", () => {
	it("reads the page in the browser when the plain request gets 403, and reports which way worked", async () => {
		const { browser, loads, challenges } = fakeBrowser({
			load: (url) => browserPage(url, article("Guarded article", "The text only a browser gets.")),
		});
		const { service } = createService({ "guarded.example": () => html("Forbidden", 403) }, browser);
		const response = await service.fetch({ urls: ["https://guarded.example/post"] });
		expect(response.failures).toEqual([]);
		expect(response.pages[0]).toMatchObject({
			url: "https://guarded.example/post",
			title: "Guarded article",
			markdown: expect.stringContaining("The text only a browser gets."),
		});
		expect(loads).toEqual(["https://guarded.example/post"]);
		expect(challenges).toEqual([]);
	});

	it("uses the browser for a page that only has text after its scripts ran, and for a robot check served with 200", async () => {
		const { browser, loads } = fakeBrowser({
			load: (url) => browserPage(url, article("Rendered", "Text that JavaScript put on the page.")),
		});
		const { service } = createService(
			{
				"spa.example": () => html('<html><body><div id="root"></div></body></html>'),
				"shielded.example": () => html(challengePage),
			},
			browser,
		);
		const response = await service.fetch({ urls: ["https://spa.example/", "https://shielded.example/"] });
		expect(response.failures).toEqual([]);
		expect(response.pages.map((page) => page.title)).toEqual(["Rendered", "Rendered"]);
		expect(loads.sort()).toEqual(["https://shielded.example/", "https://spa.example/"]);
	});

	it("does not start a browser for errors that are not refusals", async () => {
		const { browser, loads } = fakeBrowser({ load: (url) => browserPage(url, article("x", "y")) });
		const { service } = createService(
			{
				"missing.example": () => html("not found", 404),
				"broken.example": () => html("oops", 500),
				"pdf.example": () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }),
			},
			browser,
		);
		const response = await service.fetch({
			urls: ["https://missing.example/", "https://broken.example/", "https://pdf.example/", "https://gone.example/"],
		});
		expect(response.failures.map((failure) => failure.code)).toEqual(["http", "http", "unavailable"]);
		expect(response.pages[0]?.markdown).toContain("已损坏");
		expect(loads).toEqual([]);
	});

	it("opens a window for the person when the browser hits a login, waits, and then reads the page that appears", async () => {
		const { browser, challenges } = fakeBrowser({
			load: (url) => browserPage(url, loginPage),
			challenge: (url) => [browserPage(url, loginPage), browserPage(url, article("Members only", "Welcome back."))],
		});
		const { service } = createService({ "members.example": () => html("Forbidden", 403) }, browser, {
			interactive: true,
		});
		const progress: string[] = [];
		const response = await service.fetch({
			urls: ["https://members.example/area"],
			onProgress: (message) => progress.push(message),
		});
		expect(response.failures).toEqual([]);
		expect(response.pages[0]?.markdown).toContain("Welcome back.");
		expect(challenges).toEqual(["https://members.example/area"]);
		expect(progress[0]).toContain("members.example 要求登录");
		expect(progress[0]).toContain("已打开 Chrome 窗口");
		expect(progress.at(-1)).toContain("已通过");
	});

	it("shows the help request of web_fetch as tool progress", async () => {
		const { browser } = fakeBrowser({
			load: (url) => browserPage(url, challengePage, 403),
			challenge: (url) => [browserPage(url, article("Through", "Past the check."))],
		});
		const { service } = createService({ "shielded.example": () => html(challengePage, 403) }, browser, {
			interactive: true,
		});
		const updates: string[] = [];
		const tool = createWebFetchToolDefinition(process.cwd(), { service });
		const result = await tool.execute(
			"call",
			{ urls: ["https://shielded.example/"] },
			undefined,
			(update) => updates.push(update.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
			undefined as never,
		);
		expect(updates[0]).toContain("shielded.example 要求人机验证");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Past the check.") });
	});

	it("says what the site asked for when nobody is there to help", async () => {
		const { browser, challenges } = fakeBrowser({
			load: (url) => browserPage(url, challengePage, 403),
			note: "Chrome 正在运行，没能导入。",
		});
		const { service } = createService({ "shielded.example": () => html("Forbidden", 403) }, browser);
		const response = await service.fetch({ urls: ["https://shielded.example/"] });
		expect(response.pages).toEqual([]);
		expect(response.failures[0]).toMatchObject({ code: "challenge_required" });
		const message = response.failures[0]!.message;
		expect(message).toContain("直接请求：shielded.example 拒绝了访问（HTTP 403）");
		expect(message).toContain("Chrome：shielded.example 在 Chrome 中也要求人机验证");
		expect(message).toContain("Chrome 正在运行，没能导入。");
		expect(challenges).toEqual([]);
	});

	it("reports an unfinished check with its reason and does not open the window again right away", async () => {
		let time = 1_000_000;
		const { browser, challenges } = fakeBrowser({
			load: (url) => browserPage(url, loginPage),
			challenge: (url) => [browserPage(url, loginPage)],
		});
		const { service } = createService({ "members.example": () => html("Forbidden", 403) }, browser, {
			interactive: true,
			now: () => time,
		});
		const first = await service.fetch({ urls: ["https://members.example/a"] });
		expect(first.failures[0]).toMatchObject({ code: "challenge_required" });
		expect(first.failures[0]!.message).toContain("members.example 要求登录，但没有完成");
		expect(first.failures[0]!.message).toContain("超时");
		const second = await service.fetch({ urls: ["https://members.example/b"] });
		expect(second.failures[0]!.message).toContain("短时间内不再为这个网站弹出窗口");
		expect(challenges).toEqual(["https://members.example/a"]);
		time += 3 * 60_000;
		await service.fetch({ urls: ["https://members.example/c"] });
		expect(challenges).toEqual(["https://members.example/a", "https://members.example/c"]);
	});

	it("says why the browser could not be used: switched off, or none installed", async () => {
		const page = { load: (url: string) => browserPage(url, article("x", "y")) };
		const off = fakeBrowser(page);
		const disabled = createService({ "guarded.example": () => html("Forbidden", 403) }, off.browser, {
			settings: { browserFallback: false },
		});
		const refused = await disabled.service.fetch({ urls: ["https://guarded.example/"] });
		expect(refused.failures[0]).toMatchObject({
			code: "forbidden",
			message: expect.stringContaining("无法改用浏览器：Browser Fallback 已"),
		});
		expect(off.loads).toEqual([]);

		const none = createService(
			{ "guarded.example": () => html("Forbidden", 403) },
			fakeBrowser({ ...page, available: false }).browser,
		);
		const missing = await none.service.fetch({ urls: ["https://guarded.example/"] });
		expect(missing.failures[0]?.message).toContain("无法改用浏览器：没有找到可用的浏览器");

		const without = createService({ "guarded.example": () => html("Forbidden", 403) }, null);
		expect((await without.service.fetch({ urls: ["https://guarded.example/"] })).failures[0]).toMatchObject({
			code: "forbidden",
			message: expect.stringContaining("HTTP 403"),
		});
	});

	it("refuses what the browser landed on when that is not a public address, and a page that stays a wall", async () => {
		const redirected = fakeBrowser({
			load: () => browserPage("https://intranet.example/secret", article("Internal", "secret")),
		});
		const { service } = createService({ "guarded.example": () => html("Forbidden", 403) }, redirected.browser);
		const response = await service.fetch({ urls: ["https://guarded.example/"] });
		expect(response.pages).toEqual([]);
		expect(response.failures[0]).toMatchObject({ code: "blocked" });

		const local = fakeBrowser({ load: () => browserPage("http://127.0.0.1:8080/admin", article("Local", "admin")) });
		const second = createService({ "guarded.example": () => html("Forbidden", 403) }, local.browser);
		expect((await second.service.fetch({ urls: ["https://guarded.example/"] })).failures[0]).toMatchObject({
			code: "blocked",
		});
	});
});

describe("finding installed browsers", () => {
	const installed = new Set([
		join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
	]);
	const exists = (path: string) => installed.has(path) || path === "D:\\portable\\chrome.exe";
	const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };

	it("finds Chrome and Edge in their install folders and honours the path overrides", () => {
		expect(findBrowserExecutable("chrome", env, "win32", exists)).toBe([...installed][0]);
		expect(findBrowserExecutable("edge", env, "win32", exists)).toBe([...installed][1]);
		expect(findBrowserExecutable("firefox", env, "win32", exists)).toBeUndefined();
		expect(
			findBrowserExecutable("chrome", { MYHARNESS_CHROME_PATH: "D:\\portable\\chrome.exe" }, "win32", exists),
		).toBe("D:\\portable\\chrome.exe");
		expect(
			findBrowserExecutable("edge", { ...env, MYHARNESS_EDGE_PATH: "D:\\nope.exe" }, "win32", exists),
		).toBeUndefined();
		expect(detectInstalledBrowsers(env, "win32", exists).map((browser) => [browser.kind, browser.label])).toEqual([
			["chrome", "Chrome"],
			["edge", "Edge"],
		]);
		expect(detectInstalledBrowsers({}, "win32", () => false)).toEqual([]);
	});
});

describe("importing the daily browser's cookies", () => {
	const dirs: string[] = [];
	const temp = () => {
		const dir = mkdtempSync(join(tmpdir(), "myharness-cookies-"));
		dirs.push(dir);
		return dir;
	};
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("finds the profile Firefox starts with and the profile Chrome used last", () => {
		const appData = temp();
		const firefoxRoot = join(appData, "Mozilla", "Firefox");
		mkdirSync(join(firefoxRoot, "Profiles", "abc.default-release"), { recursive: true });
		mkdirSync(join(firefoxRoot, "Profiles", "old.default"), { recursive: true });
		writeFileSync(join(firefoxRoot, "Profiles", "abc.default-release", "cookies.sqlite"), "ff");
		writeFileSync(
			join(firefoxRoot, "profiles.ini"),
			"[Install308046B0AF4A39CB]\nDefault=Profiles/abc.default-release\n\n[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/old.default\nDefault=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n",
		);
		const firefox = findDailyCookies("firefox", { env: { APPDATA: appData }, platform: "win32" });
		expect(firefox?.profile).toBe(join(firefoxRoot, "Profiles/abc.default-release"));
		expect(firefox?.files[0]).toMatchObject({ to: "cookies.sqlite" });

		const local = temp();
		const chromeRoot = join(local, "Google", "Chrome", "User Data");
		mkdirSync(join(chromeRoot, "Profile 2", "Network"), { recursive: true });
		writeFileSync(join(chromeRoot, "Profile 2", "Network", "Cookies"), "c");
		writeFileSync(
			join(chromeRoot, "Local State"),
			JSON.stringify({ profile: { last_used: "Profile 2" }, os_crypt: { encrypted_key: "k" } }),
		);
		const chrome = findDailyCookies("chrome", { env: { LOCALAPPDATA: local }, platform: "win32" });
		expect(chrome?.profile).toBe(join(chromeRoot, "Profile 2"));
		expect(chrome?.files[0]?.to).toBe(join("Default", "Network", "Cookies"));
		expect(findDailyCookies("edge", { env: { LOCALAPPDATA: local }, platform: "win32" })).toBeUndefined();
		// A folder name from the file never leaves the browser's own folder.
		writeFileSync(join(chromeRoot, "Local State"), JSON.stringify({ profile: { last_used: "..\\..\\elsewhere" } }));
		expect(findDailyCookies("chrome", { env: { LOCALAPPDATA: local }, platform: "win32" })).toBeUndefined();
	});

	it("copies the cookies and the key once, keeps the rest of the profile, and copies again after the setting was off", () => {
		const daily = temp();
		const root = temp();
		const profile = join(root, "profile");
		mkdirSync(join(daily, "Default", "Network"), { recursive: true });
		writeFileSync(join(daily, "Default", "Network", "Cookies"), "daily-cookies-1");
		writeFileSync(
			join(daily, "Local State"),
			JSON.stringify({
				os_crypt: { encrypted_key: "daily-key" },
				profile: { info_cache: { Default: { name: "Me" } } },
			}),
		);
		mkdirSync(profile, { recursive: true });
		writeFileSync(
			join(profile, "Local State"),
			JSON.stringify({ os_crypt: { encrypted_key: "own-key" }, browser: { own: true } }),
		);
		const source = {
			profile: join(daily, "Default"),
			localState: join(daily, "Local State"),
			files: [
				{ from: join(daily, "Default", "Network", "Cookies"), to: join("Default", "Network", "Cookies") },
				{
					from: join(daily, "Default", "Network", "Cookies-journal"),
					to: join("Default", "Network", "Cookies-journal"),
					optional: true,
				},
			],
		};
		const first = importDailyCookiesOnce("Chrome", root, profile, source, () => 42);
		expect(first).toMatchObject({ ok: true, at: 42, source: join(daily, "Default") });
		expect(readFileSync(join(profile, "Default", "Network", "Cookies"), "utf8")).toBe("daily-cookies-1");
		// Only the key is taken over; nothing else of the daily Local State (account names, ...) is copied.
		expect(JSON.parse(readFileSync(join(profile, "Local State"), "utf8"))).toEqual({
			os_crypt: { encrypted_key: "daily-key" },
			browser: { own: true },
		});

		writeFileSync(join(daily, "Default", "Network", "Cookies"), "daily-cookies-2");
		expect(importDailyCookiesOnce("Chrome", root, profile, source)).toMatchObject({ ok: true, at: 42 });
		expect(readFileSync(join(profile, "Default", "Network", "Cookies"), "utf8")).toBe("daily-cookies-1");
		forgetCookieImport(root);
		expect(importDailyCookiesOnce("Chrome", root, profile, source).ok).toBe(true);
		expect(readFileSync(join(profile, "Default", "Network", "Cookies"), "utf8")).toBe("daily-cookies-2");
	});

	it("leaves the profile untouched and says why when the cookies cannot be read", () => {
		const root = temp();
		const profile = join(root, "profile");
		mkdirSync(profile, { recursive: true });
		writeFileSync(join(profile, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "own-key" } }));
		expect(importDailyCookiesOnce("Edge", root, profile, undefined)).toMatchObject({
			ok: false,
			error: expect.stringContaining("没有找到你日常使用的 Edge 配置"),
		});
		const daily = temp();
		writeFileSync(join(daily, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "daily-key" } }));
		const missing = importDailyCookiesOnce("Edge", root, profile, {
			profile: daily,
			localState: join(daily, "Local State"),
			files: [{ from: join(daily, "Network", "Cookies"), to: join("Default", "Network", "Cookies") }],
		});
		expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("没有找到 Edge 的 Cookie 文件") });
		expect(JSON.parse(readFileSync(join(profile, "Local State"), "utf8"))).toEqual({
			os_crypt: { encrypted_key: "own-key" },
		});
		expect(existsSync(join(root, "cookies-imported.json"))).toBe(false);
	});
});

describe("Chrome and Edge over the DevTools pipe", () => {
	/** A browser on the other end of the pipe that answers the commands a page load needs. */
	function fakeChromium(pages: Record<string, { status: number; html: string }>) {
		const toBrowser = new PassThrough();
		const fromBrowser = new PassThrough();
		const methods: string[] = [];
		const location: Record<string, string> = {};
		let buffer = "";
		const send = (message: unknown) => fromBrowser.write(`${JSON.stringify(message)}\0`);
		toBrowser.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
				const message = JSON.parse(buffer.slice(0, end)) as {
					id: number;
					method: string;
					params: Record<string, unknown>;
					sessionId?: string;
				};
				buffer = buffer.slice(end + 1);
				methods.push(message.method);
				const reply = (result: unknown) => send({ id: message.id, result });
				const session = message.sessionId ?? "";
				if (message.method === "Browser.getVersion")
					reply({ userAgent: "Mozilla/5.0 HeadlessChrome/154.0.1.2 Safari/537.36" });
				else if (message.method === "Target.createTarget") reply({ targetId: "T1" });
				else if (message.method === "Target.attachToTarget") reply({ sessionId: "S1" });
				else if (message.method === "Page.getFrameTree") reply({ frameTree: { frame: { id: "F1" } } });
				else if (message.method === "Page.navigate") {
					const url = String(message.params.url);
					location[session] = url;
					send({
						method: "Network.responseReceived",
						sessionId: session,
						params: { type: "Document", frameId: "F1", response: { status: pages[url]?.status ?? 0 } },
					});
					reply({ frameId: "F1" });
				} else if (message.method === "Runtime.evaluate") {
					const url = location[session] ?? "about:blank";
					const expression = String(message.params.expression);
					reply({
						result: {
							value: expression.includes("outerHTML")
								? { url, title: "t", html: pages[url]?.html ?? "" }
								: { url, state: "complete", ready: expression.includes('"#results"') },
						},
					});
				} else reply({});
			}
		});
		return { bridge: new CdpBridge(toBrowser, fromBrowser), methods, toBrowser, fromBrowser };
	}

	it("opens a page, reports its status and content, hides headless mode, and closes the tab", async () => {
		const { bridge, methods, toBrowser } = fakeChromium({
			"https://site.example/": { status: 403, html: "<html><body>no</body></html>" },
		});
		const written: string[] = [];
		toBrowser.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
		await bridge.init(true, "Google Chrome");
		const snapshot = await bridge.command<PageSnapshot>(
			{ type: "open", url: "https://site.example/", selector: "#results", timeoutMs: 5_000, settleMs: 0 },
			10_000,
		);
		expect(snapshot).toMatchObject({
			tabId: "T1",
			url: "https://site.example/",
			status: 403,
			ready: true,
			html: "<html><body>no</body></html>",
		});
		expect(methods).toContain("Emulation.setUserAgentOverride");
		expect(written.join("")).toContain('"userAgent":"Mozilla/5.0 Chrome/154.0.1.2 Safari/537.36"');
		expect(written.join("")).toContain('"brand":"Google Chrome","version":"154"');
		expect(methods.at(-1)).toBe("Target.closeTarget");
		await expect(bridge.command({ type: "read", tabId: "T1", selector: "" }, 1_000)).rejects.toThrow(
			"the tab was closed",
		);
	});

	it("keeps a tab open for a person and fails everything when the browser goes away", async () => {
		const { bridge, methods, fromBrowser } = fakeChromium({
			"https://site.example/login": { status: 200, html: "<html></html>" },
		});
		await bridge.init(false, "Microsoft Edge");
		const opened = await bridge.command<PageSnapshot>(
			{
				type: "open",
				url: "https://site.example/login",
				selector: "",
				timeoutMs: 5_000,
				settleMs: 0,
				foreground: true,
				keepOpen: true,
			},
			10_000,
		);
		expect(methods).toContain("Page.bringToFront");
		expect(methods).not.toContain("Emulation.setUserAgentOverride");
		expect(methods).not.toContain("Target.closeTarget");
		const read = await bridge.command<PageSnapshot>({ type: "read", tabId: opened.tabId, selector: "" }, 1_000);
		expect(read).toMatchObject({ url: "https://site.example/login", ready: false });
		fromBrowser.destroy();
		await vi.waitFor(async () => {
			await expect(bridge.command({ type: "read", tabId: opened.tabId, selector: "" }, 1_000)).rejects.toThrow();
		});
	});
});
