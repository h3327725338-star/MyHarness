import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FirefoxBrowser, findFirefoxExecutable } from "../src/tools/web-search/browser/firefox.ts";

describe("Firefox detection", () => {
	it("prefers MYHARNESS_FIREFOX_PATH, then the usual install folders, then PATH", () => {
		const files = new Set([
			"C:\\Custom\\firefox.exe",
			join("C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
			join("D:\\tools", "firefox.exe"),
		]);
		const exists = (path: string) => files.has(path);
		expect(findFirefoxExecutable({ MYHARNESS_FIREFOX_PATH: "C:\\Custom\\firefox.exe" }, "win32", exists)).toBe(
			"C:\\Custom\\firefox.exe",
		);
		// An override that does not exist is reported as missing instead of silently ignored.
		expect(findFirefoxExecutable({ MYHARNESS_FIREFOX_PATH: "C:\\nope.exe" }, "win32", exists)).toBeUndefined();
		expect(findFirefoxExecutable({ ProgramFiles: "C:\\Program Files" }, "win32", exists)).toBe(
			join("C:\\Program Files", "Mozilla Firefox", "firefox.exe"),
		);
		expect(findFirefoxExecutable({ PATH: "D:\\tools" }, "win32", exists)).toBe(join("D:\\tools", "firefox.exe"));
		expect(findFirefoxExecutable({}, "win32", exists)).toBeUndefined();
		const browser = new FirefoxBrowser({ findExecutable: () => undefined, rootDir: tmpdir() });
		expect(browser.state()).toEqual({ available: false, reason: expect.stringContaining("没有找到 Firefox") });
	});
});

// Starts the user's real Firefox. Opt in with MYHARNESS_FIREFOX_E2E=1 (the web search E2E script sets it).
const realFirefox = process.env.MYHARNESS_FIREFOX_E2E === "1" && findFirefoxExecutable() !== undefined;

describe.skipIf(!realFirefox)("Firefox transport with a real Firefox", () => {
	let server: Server;
	let base = "";
	let rootDir = "";
	let browser: FirefoxBrowser;

	beforeAll(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "myharness-firefox-"));
		server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const send = (status: number, body: string, headers: Record<string, string> = {}) => {
				response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
				response.end(body);
			};
			switch (url.pathname) {
				case "/results":
					return send(
						200,
						`<html><body><ol id="results"><li>${url.searchParams.get("q") ?? ""}</li></ol></body></html>`,
					);
				case "/js-redirect":
					// Like Google's first answer: a script that moves on to the real page.
					return send(
						200,
						`<html><body><script>setTimeout(()=>location.replace("/results?q=after-js"),300)</script></body></html>`,
					);
				case "/limited":
					return send(429, "<html><body>Too many requests</body></html>");
				case "/challenge":
					// Stands in for a person passing a CAPTCHA: the page moves on by itself after a moment.
					return send(
						200,
						`<html><body><form id="captcha-form"></form><script>setTimeout(()=>location.replace("/results?q=solved"),1500)</script></body></html>`,
					);
				case "/set-cookie":
					return send(200, "<html><body><p id='done'>ok</p></body></html>", {
						"Set-Cookie": "session=kept; Max-Age=86400; Path=/",
					});
				case "/echo-cookie":
					return send(200, `<html><body><p id="cookie">${request.headers.cookie ?? "none"}</p></body></html>`);
				case "/slow":
					setTimeout(() => send(200, "<html><body><p id='late'>late</p></body></html>"), 15_000);
					return;
				default:
					return send(404, "not found");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
		browser = new FirefoxBrowser({ rootDir });
	}, 60_000);

	afterAll(async () => {
		await browser?.shutdown();
		server?.close();
		server?.closeAllConnections();
		// Firefox child processes can hold profile files for a moment after the browser exits.
		rmSync(rootDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}, 60_000);

	it("loads a page headless through the extension and waits for the results selector", async () => {
		const page = await browser.load({ url: `${base}/results?q=hello`, readySelector: "#results li", label: "Local" });
		expect(page).toMatchObject({ status: 200, via: "browser", ready: true, url: `${base}/results?q=hello` });
		expect(page.text).toContain("<li>hello</li>");
		expect(await browser.runningMode()).toBe("headless");
	}, 60_000);

	it("follows script redirects to the final page and reports the HTTP status of refused pages", async () => {
		const redirected = await browser.load({ url: `${base}/js-redirect`, readySelector: "#results", label: "Local" });
		expect(redirected.url).toBe(`${base}/results?q=after-js`);
		expect(redirected.text).toContain("after-js");
		const limited = await browser.load({ url: `${base}/limited`, readySelector: "#results", label: "Local" });
		expect(limited).toMatchObject({ status: 429, ready: false });
	}, 60_000);

	it("fails fast with a clear error when the page cannot load", async () => {
		const started = Date.now();
		await expect(
			browser.load({ url: "http://127.0.0.1:9/unreachable", readySelector: "#x", label: "Local" }),
		).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("Local") });
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 60_000);

	it("cancels a slow page load", async () => {
		const controller = new AbortController();
		const pending = browser.load({ url: `${base}/slow`, readySelector: "#late", label: "Local" }, controller.signal);
		setTimeout(() => controller.abort(), 500);
		const started = Date.now();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 60_000);

	it("opens a visible window for a challenge, waits until it is solved, then returns to headless", async () => {
		const page = await browser.solveChallenge({
			url: `${base}/challenge`,
			readySelector: "#results",
			label: "Local",
			isSolved: (candidate) => candidate.ready === true && !candidate.text.includes("captcha-form"),
		});
		expect(page.url).toBe(`${base}/results?q=solved`);
		expect(await browser.runningMode()).toBeUndefined(); // closed after the challenge
		await browser.load({ url: `${base}/results?q=again`, readySelector: "#results", label: "Local" });
		expect(await browser.runningMode()).toBe("headless");
	}, 90_000);

	it("keeps cookies in the dedicated profile across a MyHarness restart", async () => {
		await browser.load({ url: `${base}/set-cookie`, readySelector: "#done", label: "Local" });
		await browser.shutdown();
		const restarted = new FirefoxBrowser({ rootDir });
		try {
			const page = await restarted.load({ url: `${base}/echo-cookie`, readySelector: "#cookie", label: "Local" });
			expect(page.text).toContain("session=kept");
		} finally {
			await restarted.shutdown();
		}
	}, 90_000);

	it("lets only one browser instance own the profile", async () => {
		await browser.load({ url: `${base}/results?q=owner`, readySelector: "#results", label: "Local" });
		const second = new FirefoxBrowser({ rootDir });
		await expect(
			second.load({ url: `${base}/results?q=second`, readySelector: "#results", label: "Local" }),
		).rejects.toMatchObject({ code: "browser_unavailable", message: expect.stringContaining("另一个 MyHarness") });
		await second.shutdown();
	}, 60_000);

	it("reports a Firefox crash to pending loads and starts a new Firefox for the next one", async () => {
		await browser.load({ url: `${base}/results?q=warm`, readySelector: "#results", label: "Local" });
		const pending = browser.load({ url: `${base}/slow`, readySelector: "#late", label: "Local" });
		await new Promise((resolve) => setTimeout(resolve, 800));
		const pid = Number(readFileSync(join(rootDir, "firefox.pid"), "utf8"));
		process.kill(pid);
		await expect(pending).rejects.toMatchObject({ code: "browser_unavailable" });
		const next = await browser.load({
			url: `${base}/results?q=recovered`,
			readySelector: "#results",
			label: "Local",
		});
		expect(next.text).toContain("recovered");
	}, 90_000);
});
