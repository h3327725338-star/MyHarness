import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findFirefoxExecutable, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";
import { forgetCookieImport, importDailyCookiesOnce } from "../src/tools/web-search/browser/import-cookies.ts";

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !findFirefoxExecutable())(
	"reuses cookies from a real Firefox while the source Firefox remains running",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-hot-cookie-browser-"));
		const server = createServer((req, res) => {
			res.writeHead(200, {
				"Content-Type": "text/html",
				...(req.url === "/set" ? { "Set-Cookie": "hot_cookie=present; Path=/; Max-Age=3600" } : {}),
			});
			res.end(
				`<html><body><p id="ready">${req.url === "/set" ? "set" : req.headers.cookie?.includes("hot_cookie=present") ? "cookie present" : "cookie absent"}</p></body></html>`,
			);
		});
		const sourceRoot = join(root, "source");
		const sourceProfile = join(sourceRoot, "profile");
		const targetRoot = join(root, "target");
		const cookies = {
			profile: sourceProfile,
			files: [{ from: join(sourceProfile, "cookies.sqlite"), to: "cookies.sqlite" }],
		};
		const source = new LocalBrowser({ kind: "firefox", rootDir: sourceRoot });
		const target = new LocalBrowser({ kind: "firefox", rootDir: targetRoot, findDailyCookies: () => cookies });
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			const origin = `http://127.0.0.1:${port}`;
			await source.load({ url: `${origin}/set`, readySelector: "#ready", label: "Set test cookie" });
			// Firefox commits persistent cookies asynchronously; retry snapshots, not source shutdown.
			let copied = false;
			for (let attempt = 0; attempt < 20 && !copied; attempt++) {
				const record = importDailyCookiesOnce("Firefox", targetRoot, join(targetRoot, "profile"), cookies);
				if (record.ok) {
					const { DatabaseSync } = await import("node:sqlite");
					const snapshot = new DatabaseSync(join(targetRoot, "profile", "cookies.sqlite"), { readOnly: true });
					try {
						copied = !!snapshot.prepare("SELECT name FROM moz_cookies WHERE name = 'hot_cookie'").get();
					} finally {
						snapshot.close();
					}
				}
				if (!copied) {
					forgetCookieImport(targetRoot);
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			expect(copied).toBe(true);
			target.useDailyCookies = true;
			expect(
				(await target.load({ url: `${origin}/read`, readySelector: "#ready", label: "Read imported cookie" })).text,
			).toContain("cookie present");
			expect(
				(await source.load({ url: `${origin}/read`, readySelector: "#ready", label: "Source is still running" }))
					.text,
			).toContain("cookie present");
		} finally {
			await target.shutdown();
			await source.shutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60_000,
);
