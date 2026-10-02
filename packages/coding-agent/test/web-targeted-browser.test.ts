import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders permanent Git records, precision meters and an anchored sidebar menu in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-targeted-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/status", () => ({
				gitAvailable: true,
				isRepository: true,
				branch: "main",
				preview: { total: 1 },
			}));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/panels.css"><div id="side" style="position:absolute;right:0;top:20px;width:400px;height:700px"><div id="menu"></div></div><div id="record"></div><div id="cache"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {GitBar} from '/js/panel-changes.js';
import {GitRecord} from '/js/git-record.js';
import {CacheValue} from '/js/context-usage.js';
import {set} from '/js/store.js';
const wait = ms => new Promise(r=>setTimeout(r,ms));
try {
 set({snap:{active:false,checkpoint:null}});
 const status={gitAvailable:true,isRepository:true,branch:'main',preview:{total:1},head:{sha:'abcdef1'}};
 render(h(GitBar,{gitStatus:status,active:false}),document.getElementById('menu'));
 render(h(GitRecord,{result:{tone:'ok',title:'Commit succeeded',hash:'abc1234',detail:'saved'}}),document.getElementById('record'));
 render(h(CacheValue,{cache:{state:'final',hitRate:0.99876,read:99876,input:100000}}),document.getElementById('cache'));
 if(navigator.webdriver !== undefined || 'webdriver' in navigator) throw Error('automation marker');
 await wait(100);
 const trigger=document.querySelector('[data-git-menu-trigger]'); trigger.click(); await wait(250);
 const a=trigger.getBoundingClientRect(), p=document.querySelector('.gitbar-menu').getBoundingClientRect(), s=document.getElementById('side').getBoundingClientRect();
 if(p.top<a.bottom || p.left<s.left || p.right>s.right) throw Error('menu left sidebar');
 if(!document.querySelector('.gitbar-menu .cp')) throw Error('missing command panel');
 if(document.getElementById('cache').textContent.trim()!=='99.88%') throw Error('cache precision');
 render(h(CacheValue,{cache:{state:'final',hitRate:1,read:100000,input:100000}}),document.getElementById('cache'));
 await wait(50);
 if(document.getElementById('cache').textContent.trim()!=='100.00%') throw Error('full cache precision');
 trigger.click(); await wait(100);
 if(document.querySelector('.gitbar-menu')) throw Error('menu does not toggle closed');
 await wait(9200);
 if(!document.getElementById('record').textContent.includes('abc1234')) throw Error('record disappeared');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Targeted UI",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60_000,
);
