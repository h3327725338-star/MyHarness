import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps resized and collapsed transcripts pinned and settings navigation on one line",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-scroll-settings-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/settings", () => ({ items: [] }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><style>#app{height:350px;width:900px}.transcript-wrap{height:350px}</style><div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,message)=>{if(!ok)throw Error(message)};
try {
 set({snap:{session:{id:'test'},active:false},items:[]});
 render(h(Transcript),document.getElementById('app')); await wait(100);
 const scroller=document.querySelector('.transcript'),content=document.querySelector('.transcript-inner');
 const card=document.createElement('div');card.style.height='1200px';content.prepend(card);await wait(100);
 const bottom=()=>scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<=10;
 assert(bottom()&&!document.querySelector('.jump-btn'),'growth must stay pinned');
 card.style.height='1600px';await wait(100);
 assert(bottom()&&!document.querySelector('.jump-btn'),'expanded card must stay pinned');
 card.style.height='900px';await wait(100);
 assert(bottom()&&!document.querySelector('.jump-btn'),'collapsed card must stay pinned');
 scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-200,bubbles:true}));scroller.scrollTop-=200;await wait(100);
 assert(document.querySelector('.jump-btn'),'reader scrolling up must show button');
 card.style.height='1100px';await wait(100);
 assert(document.querySelector('.jump-btn'),'reading older output must not be forced down');
 let fading=false;new MutationObserver(()=>{if(document.querySelector('.jump-btn.leaving'))fading=true;}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
 document.querySelector('.jump-btn').click();await wait(700);
 assert(bottom()&&!document.querySelector('.jump-btn:not(.leaving)'),'jump must hide button');
 assert(fading&&!document.querySelector('.jump-btn'),'jump button must fade out and then leave');
 scroller.style.height='300px';await wait(100);
 assert(bottom()&&!document.querySelector('.jump-btn:not(.leaving)'),'viewport resize must stay pinned');
 for(const lang of ['en','zh-CN']) {
  setView({lang,settingsSection:'appearance'});render(h(SettingsModal),document.getElementById('app'));await wait(200);
  const buttons=[...document.querySelectorAll('.settings-nav button')];assert(buttons.length>0,'missing settings navigation');
  for(const button of buttons) {
   assert(getComputedStyle(button).whiteSpace==='nowrap','navigation wraps');
   assert(button.scrollWidth<=button.clientWidth,'navigation overflows: '+button.textContent);
  }
  assert(document.querySelector('.settings-body').clientWidth>=600,'settings body squeezed');
 }
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Scroll and settings test",
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
