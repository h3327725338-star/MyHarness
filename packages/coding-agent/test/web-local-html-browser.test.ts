import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { registerHtmlPreview } from "../src/modes/web/html-preview.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// A local HTML page linked in a chat opens as a website tab of the built-in browser in the desktop app (local-files.js),
// at the address a file tab's preview uses; that address loads as a page of its own with its folder's files. Without
// the built-in browser (a plain browser window) it still opens as a file tab.
const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"a local HTML link opens in the built-in browser and its address loads as a page",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "local-html-"));
		const site = join(root, "site");
		mkdirSync(site);
		const page = join(site, "week4-可视化.html");
		writeFileSync(
			page,
			'<!doctype html><html><head><title>w4</title><link rel="stylesheet" href="style.css"></head><body><p id="mark">visual page</p><img id="pic" src="pic.svg"><script>const img=document.getElementById("pic");const done=()=>document.body.insertAdjacentHTML("beforeend",\'<p id="loaded">\'+(img.naturalWidth>0?"image ok":"image missing")+" "+getComputedStyle(document.getElementById("mark")).color+"</p>");img.complete?done():img.addEventListener("load",done),img.addEventListener("error",done);</script></body></html>',
		);
		writeFileSync(join(site, "style.css"), "#mark { color: rgb(1, 2, 3); }");
		writeFileSync(
			join(site, "pic.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>',
		);
		writeFileSync(join(site, "notes.txt"), "plain");
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("POST", "/api/files/local", ({ body }) => {
				const { path } = body as { path: string };
				return { path: resolve(site, path), directory: false };
			});
			registerHtmlPreview(server, (input) => resolve(site, String(input)));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><div id="out"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {state,activeSlotId} from '/js/store.js';
import {openLocalFileInWorkspace} from '/js/local-files.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const active=()=>state.view.wsTabs.find((tab)=>tab.id===state.view.wsActive);
try{
 // A plain browser window has no built-in browser: the page opens as a file tab with its preview.
 await openLocalFileInWorkspace('notes.txt',activeSlotId());
 must(active()?.type==='file','text file: '+JSON.stringify(active()));
 await openLocalFileInWorkspace('week4-可视化.html',activeSlotId());
 must(active()?.type==='file'&&active().path.endsWith('.html'),'html without the desktop app: '+JSON.stringify(active()));
 // The desktop app: an HTML page becomes a website tab; other files stay file tabs.
 window.myHarnessDesktop={browser:async()=>({ok:true})};
 await openLocalFileInWorkspace('week4-可视化.html',activeSlotId());
 const tab=active();
 must(tab?.type==='browser'&&tab.url.startsWith(location.origin+'/api/files/site/'),'html in the desktop app: '+JSON.stringify(tab));
 await openLocalFileInWorkspace('week4-可视化.html',activeSlotId());
 must(state.view.wsTabs.filter((item)=>item.type==='browser').length===1,'the same page opened twice: '+JSON.stringify(state.view.wsTabs));
 await openLocalFileInWorkspace('notes.txt',activeSlotId());
 must(active()?.type==='file','text file in the desktop app: '+JSON.stringify(active()));
 document.getElementById('out').insertAdjacentHTML('beforeend','<p id="ready">passed <a id="url" href="'+tab.url+'">url</a></p>');
}catch(error){document.getElementById('out').insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const first = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Local HTML link",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(first.text).toContain('id="ready">passed');
			const url = /id="url" href="([^"]+)"/.exec(first.text)?.[1]?.replaceAll("&amp;", "&");
			expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/files/site/`));
			// The website tab loads that address by itself (a top-level navigation, as the built-in browser does).
			const opened = await browser.solveChallenge({
				url: url!,
				readySelector: "#loaded",
				label: "Local HTML page",
				isSolved: (candidate) => candidate.text.includes('id="loaded"'),
			});
			expect(opened.text).toContain("visual page");
			expect(opened.text).toContain("image ok rgb(1, 2, 3)");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60000,
);
