import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { WebLifecycle } from "../src/modes/web/lifecycle.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_RELOAD_BROWSER_E2E !== "1" || !installed.length)(
	"survives repeated real browser reloads with zero configured delay, then expires after the page closes",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-web-reload-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let expired = 0;
		const lifecycle = new WebLifecycle({ getGraceSeconds: () => 0, onExpire: () => expired++ });
		server.onClientCountChange = (count) => lifecycle.clientCountChanged(count);
		try {
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(join(root, "index.html"), '<!doctype html><script src="/test/reload.js"></script>');
			writeFileSync(
				join(root, "reload.js"),
				`
const source = new EventSource('/api/events');
source.onopen = () => {
 const reloads = Number(sessionStorage.getItem('reloads') || 0);
 if (reloads < 12) {
  sessionStorage.setItem('reloads', String(reloads + 1));
  setTimeout(() => location.reload(), 150);
 } else {
  setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed 12 reloads</p>'), 5500);
 }
};
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Web reload regression",
				isSolved: (candidate) => candidate.text.includes("passed 12 reloads"),
			});
			expect(page.text).toContain("passed 12 reloads");
			expect(expired).toBe(0);
			await browser.shutdown();
			await new Promise((resolve) => setTimeout(resolve, 5500));
			expect(server.clientCount).toBe(0);
			expect(expired).toBe(1);
		} finally {
			lifecycle.dispose();
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60_000,
);
