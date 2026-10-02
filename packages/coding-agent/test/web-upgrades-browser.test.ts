import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"preserves expanded steps through completion and renders Markdown change cards automatically",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-upgrades-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("GET", "/api/changes/card-diff", () => ({
				summary: {},
				patch: "--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-# Before\n+# After\n",
			}));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><div id="checks"></div><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {Collapse,Modal} from '/js/ui.js';
import {StepCounts} from '/js/step-counts.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 document.documentElement.dataset.motion='on';
 const checks=document.getElementById('checks');
 render(h(Modal,{title:'Settings',focusInput:false},h('input',{'aria-label':'Reading width'})),checks);
 await wait(100);
 if(document.activeElement!==document.querySelector('.modal')) throw Error('settings input focused');
 const fold=open=>render(h(Collapse,{open},h('div',{style:'height:200px'},'content')),checks);
 fold(false); await wait(50); fold(true); await wait(100);
 const mid=document.querySelector('.collapse').getBoundingClientRect().height;
 if(mid<=0 || mid>=200) throw Error('expand hard cut: '+mid);
 await wait(300); fold(false); await wait(100);
 const closing=document.querySelector('.collapse').getBoundingClientRect().height;
 if(closing<=0 || closing>=200) throw Error('collapse hard cut: '+closing);
 await wait(300);
 const counts=(additions,deletions,running)=>render(h(StepCounts,{additions,deletions,running}),checks);
 counts(undefined,undefined,true); counts(4,2,true); await wait(100);
 if(document.querySelector('.count-current')) throw Error('counts bypassed period');
 await wait(2910);
 const up=document.querySelector('.count-current.roll-up'),down=document.querySelector('.count-current.roll-down');
 if(!up || !down || !up.getAnimations().length || !down.getAnimations().length) throw Error('counts not animating');
 if(getComputedStyle(up).transform===getComputedStyle(down).transform) throw Error('count directions identical');
 await wait(350); const first=up;
 await wait(3000);
 if(document.querySelector('.count-current.roll-up')!==first || first.getAnimations().some(a=>a.playState==='running')) throw Error('unchanged replay');
 counts(7,3,false); await wait(50);
 if(document.querySelector('.count-current.roll-up')===first || !document.querySelector('.count-current.roll-up').getAnimations().length) throw Error('final counts not animating');
 render(null,checks);
 const items=[{kind:'user',id:'u1',ts:1,text:'test',images:[]},{kind:'assistant',id:'a1',ts:2,model:'test',blocks:[{type:'toolCall',id:'c1',name:'read',args:{path:'doc.md'}}]},{kind:'toolResult',ts:3,toolCallId:'c1',toolName:'read',text:'# Read result',images:[],isError:false}];
 setView({processDefault:'expanded'});
 set({items,snap:{active:true,cwd:'C:/test',flags:{},session:{id:'test'},run:{startedAt:Date.now()}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],models:[]});
 render(h(Transcript,{}),document.getElementById('app')); await wait(350);
 if(document.querySelector('.summary-head').getAttribute('aria-expanded')!=='true') throw Error('default not expanded');
 document.querySelector('.action-row').click(); await wait(350);
 if(!document.querySelector('.raw')) throw Error('child not expanded');
 set({snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'}},items:[...items,{kind:'assistant',id:'final',ts:4,model:'test',blocks:[{type:'text',text:'Done'}],stopReason:'stop'},{kind:'runChanges',id:'card',runId:1,ts:5,files:[{path:'doc.md',additions:1,deletions:1}]}]}); await wait(350);
 if(document.querySelector('.summary-head').getAttribute('aria-expanded')!=='true' || !document.querySelector('.raw')) throw Error('completion reset expansion');
 document.querySelector('.change-file').click(); await wait(700);
 if(!document.querySelector('.md-diff h1') || document.querySelector('.change-diff-bar')) throw Error('Markdown not automatic');
 document.querySelector('.summary-head').click(); await wait(400);
 setView({processDefault:'collapsed'}); setView({processDefault:'expanded'}); await wait(350);
 if(document.querySelector('.summary-head').getAttribute('aria-expanded')!=='false') throw Error('user fold overwritten');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "UI upgrades",
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
