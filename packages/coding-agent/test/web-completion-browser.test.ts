import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows delayed real completion phases and clears timers across chats in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-completion-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {set} from '/js/store.js';
const wait = ms => new Promise(r=>setTimeout(r,ms));
const strip = () => document.querySelector('.strip[key="f"]') || [...document.querySelectorAll('.strip')].find(n=>/task|memory/.test(n.textContent));
try {
 set({snap:{active:false,trust:{trusted:true},flags:{},queue:{steering:[],followUp:[]},model:null,thinking:{levels:[]}},queue:{steering:[],followUp:[]},completion:false});
 render(h(Composer),document.getElementById('app'));
 const first = Date.now();
 set({completion:{phase:'changes',startedAt:first}}); await wait(100);
 if(strip()) throw Error('short task flashes');
 set({completion:false}); await wait(550);
 if(strip()) throw Error('stale timer after short task');
 set({completion:{phase:'changes',startedAt:Date.now()-600}}); await wait(80);
 if(!strip()?.textContent.includes("Checking this task's file changes")) throw Error('snapshot phase missing');
 if(strip().textContent.includes('memory')) throw Error('memory mentioned while disabled');
 const startedAt=Date.now()-600;
 set({completion:{phase:'memory',startedAt}}); await wait(80);
 if(!strip()?.textContent.includes('Organizing long-term memory')) throw Error('memory phase missing');
 set({completion:{phase:'records',startedAt}}); await wait(80);
 if(!strip()?.textContent.includes('Saving task records')) throw Error('phase change delayed');
 set({completion:false}); await wait(80);
 if(strip()) throw Error('completion not cleared');
 set({completion:{phase:'changes',startedAt:Date.now()}}); await wait(80);
 set({completion:false}); await wait(550);
 if(strip()) throw Error('chat switch left stale timer');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Completion UI",
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
