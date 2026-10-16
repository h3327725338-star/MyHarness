import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders 8 skeleton rows on first load without whole spinner, prevents jumping, keeps old lines on refresh, and disables animation under reduced motion",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-skeleton-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});

		try {
			for (const dir of ["js", "vendor", "css"]) {
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			}

			const files = [
				{ path: "src/index.ts", status: "modified", additions: 10, deletions: 2 },
				{ path: "src/utils.ts", status: "modified", additions: 4, deletions: 1 },
				{ path: "src/view.ts", status: "added", additions: 32, deletions: 0 },
				{ path: "src/types.ts", status: "modified", additions: 2, deletions: 2 },
				{ path: "README.md", status: "modified", additions: 1, deletions: 1 },
				{ path: "package.json", status: "modified", additions: 3, deletions: 0 },
				{ path: "test/index.test.ts", status: "added", additions: 20, deletions: 0 },
				{ path: "test/view.test.ts", status: "modified", additions: 8, deletions: 3 },
			];

			let callCount = 0;
			const freshParams: Array<string | null> = [];
			server.route("GET", "/api/changes", async ({ url }) => {
				callCount++;
				freshParams.push(url.searchParams.get("fresh"));
				if (callCount === 1) {
					await new Promise((resolve) => setTimeout(resolve, 600));
				} else {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				return { total: files.length, files };
			});

			let diffCallCount = 0;
			server.route("GET", "/api/changes/diff", async ({ url }) => {
				diffCallCount++;
				const filePath = url.searchParams.get("path") || "src/index.ts";
				if (diffCallCount > 1) {
					await new Promise((resolve) => setTimeout(resolve, 300));
				}
				return {
					patch: `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,3 +1,4 @@\n+export const ok = 1;\n`,
					summary: { additions: 1, deletions: 0 },
				};
			});

			server.route("GET", "/api/changes-fresh-probe", () => freshParams);

			server.route("GET", "/api/git/status", () => ({
				gitAvailable: true,
				isRepository: true,
				branch: "main",
				preview: { total: files.length },
				head: { sha: "abc1234" },
			}));

			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12000));
				return {};
			});

			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app" style="height:700px;display:flex;flex-direction:column;"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);

			writeFileSync(
				join(root, "test.js"),
				`
import { h, render } from '/vendor/preact.js';
import { ChangesPanel } from '/js/panel-changes.js';
import { set, setView } from '/js/store.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, msg) => { if (!ok) throw Error(msg); };
const until = async (fn) => {
	for (let i = 0; i < 100; i++) {
		if (fn()) return;
		await wait(50);
	}
	throw Error('timed out waiting for UI condition');
};

try {
	setView({ motion: 'on', lang: 'zh-CN' });
	set({
		connected: true,
		activeSlot: 'test-slot',
		snap: { slot: 'test-slot', session: { id: 'test-sess' }, flags: {}, active: false },
		gitStatus: { gitAvailable: true, isRepository: true, branch: 'main', preview: { total: 8 }, head: { sha: 'abc1234' } },
		view: { changesScope: 'worktree' },
	});

	render(h(ChangesPanel, {}), document.getElementById('app'));

	// 1. Initial skeleton assertion: 8 skeleton items, no full-page spinner
	await wait(80);
	const skItems = document.querySelectorAll('.cfile.sk');
	check(skItems.length === 8, 'expected 8 skeleton rows, found ' + skItems.length);
	check(!document.querySelector('.empty .spinner'), 'full-page spinner found during initial load');

	const listEl = document.querySelector('.cfiles-list');
	check(listEl, 'missing .cfiles-list container during skeleton');
	const skeletonHeight = listEl.getBoundingClientRect().height;
	check(skeletonHeight > 0, 'skeleton list container height should be > 0');

	// 4. Reduced-motion check: animationName === "none"
	const normalAnim = getComputedStyle(skItems[0]).animationName;
	check(normalAnim !== 'none', 'skeleton missing pulse animation in normal mode, got ' + normalAnim);

	document.documentElement.setAttribute('data-motion', 'off');
	const offAnim = getComputedStyle(skItems[0]).animationName;
	check(offAnim === 'none', 'expected animationName === none when motion is off, got ' + offAnim);
	document.documentElement.removeAttribute('data-motion');

	let foundReducedMotionMedia = false;
	for (const sheet of document.styleSheets) {
		try {
			for (const rule of sheet.cssRules) {
				if (rule.media && rule.media.mediaText.includes('prefers-reduced-motion') && rule.cssText.includes('.cfile.sk') && rule.cssText.includes('none')) {
					foundReducedMotionMedia = true;
				}
			}
		} catch (e) {}
	}
	check(foundReducedMotionMedia, 'missing @media (prefers-reduced-motion: reduce) rule for .cfile.sk in stylesheet');

	// 2. Wait for real data to arrive: skeleton disappears, real items appear, height jump <= 26px
	await until(() => document.querySelectorAll('.cfile:not(.sk)').length > 0);
	check(document.querySelectorAll('.cfile.sk').length === 0, 'skeleton rows still present after data arrived');

	const realListEl = document.querySelector('.cfiles-list');
	check(realListEl, 'missing .cfiles-list container with real data');
	const realHeight = realListEl.getBoundingClientRect().height;
	const heightDiff = Math.abs(realHeight - skeletonHeight);
	check(heightDiff <= 26, 'container height jumped by ' + heightDiff + 'px (skeleton: ' + skeletonHeight + 'px, real: ' + realHeight + 'px)');

	document.getElementById('app').setAttribute('data-skeleton-height', String(skeletonHeight));
	document.getElementById('app').setAttribute('data-real-height', String(realHeight));
	document.getElementById('app').setAttribute('data-height-diff', String(heightDiff));

	// 3. Refresh test: clicking refresh keeps old rows on screen, does not flash skeleton, shows inline spinner
	const refreshBtn = document.querySelector('.panel-toolbar button.icon-btn:last-child');
	check(refreshBtn, 'refresh button not found');
	refreshBtn.click();

	await wait(60);
	check(document.querySelectorAll('.cfile.sk').length === 0, 'skeleton flashed during refresh');
	check(document.querySelectorAll('.cfile:not(.sk)').length === 8, 'real file rows cleared during refresh');
	check(document.querySelector('.changes-toolbar-spinner') || document.querySelector('.cfiles-head-spinner'), 'inline refresh spinner missing during refresh');

	await until(() => !document.querySelector('.changes-toolbar-spinner'));
	check(document.querySelectorAll('.cfile:not(.sk)').length === 8, 'real file rows lost after refresh');
	check(document.querySelectorAll('.cfile.sk').length === 0, 'skeleton appeared after refresh');

	const freshParams = await (await fetch('/api/changes-fresh-probe')).json();
	check(freshParams.length === 2, 'expected 2 changes requests, got ' + freshParams.length);
	check(freshParams[0] === null, 'first load should not send fresh, got ' + freshParams[0]);
	check(freshParams[1] === '1', 'refresh click should send fresh=1, got ' + freshParams[1]);

	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed; skeletonHeight=' + skeletonHeight + '; realHeight=' + realHeight + '; heightDiff=' + heightDiff + '</p>');
} catch (error) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">ERROR: ' + error.message + '</p>');
}
`,
			);

			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Changes skeleton",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});

			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60000,
);
