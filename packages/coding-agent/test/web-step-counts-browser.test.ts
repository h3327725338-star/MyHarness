import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"retains group previews, corrects without rolling and animates failed counts out",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "step-counts-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind, rootDir: join(root, "browser") });
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(join(root, "index.html"), '<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>');
			writeFileSync(join(root, "test.js"), `
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {StepCounts} from '/js/step-counts.js';
import {set,setView} from '/js/store.js';
const app=document.getElementById('app'),wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const props={additions:15,deletions:7,running:true};
 render(h(StepCounts,props),app);
 render(h(StepCounts,{...props,deletions:0,removed:1}),app);await wait(250);
 if(!app.querySelector('.del .roll-down')) throw Error('rollback not animated');
 if(app.querySelector('.add .roll-up')) throw Error('unchanged additions animated');
 await wait(400);if(app.querySelector('.del')) throw Error('minus zero retained');
 render(h(StepCounts,{removed:2,running:false}),app);await wait(1200);
 if(app.querySelector('.counts')) throw Error('zero counts retained');
 render(null,app);
 setView({processDefault:'expanded'});
 const call=(id,preview)=>({type:'toolCall',id,name:'edit',args:{path:id+'.ts'},...(preview?{changePreview:preview}:{})});
 const patch=n=>'@@ -0,0 +1,'+n+' @@\\n'+Array(n).fill('+new').join('\\n');
 const baseItems=[{kind:'user',id:'u',ts:1,text:'edit',images:[]},{kind:'assistant',id:'a',ts:2,blocks:[call('done'),call('live',{additions:20,deletions:2})],stopReason:'toolUse'},{kind:'toolResult',ts:3,toolCallId:'done',toolName:'edit',details:{patch:patch(12)},isError:false}];
 set({items:baseItems,snap:{active:true,cwd:'C:/test',flags:{},session:{id:'test'}},toolRuns:{},runs:{},dialogs:[],userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),app);await wait(300);
 const head=()=>app.querySelector('.group-head');
 const add=()=>Number(head().querySelector('.add .count-current').textContent);
 if(add()!==32) throw Error('initial group total');
 set({items:baseItems.map(i=>i.id==='a'?{...i,blocks:[call('done'),call('live')]}:i)});await wait(300);
 if(add()!==32||!head().querySelector('.count-preview')) throw Error('missing preview deducted');
 set({toolRuns:{live:{status:'running',partialDetails:{patch:patch(24)}}}});await wait(300);
 if(add()!==36||head().querySelector('.count-preview')||head().querySelector('.roll-up')) throw Error('validated correction rolled');
 set({items:[...baseItems,{kind:'toolResult',ts:4,toolCallId:'live',toolName:'edit',isError:true,text:'failed'}]});await wait(250);
 if(!head().querySelector('.roll-up')) throw Error('group failure not animated');
 await wait(400);if(add()!==12||head().querySelector('.del')) throw Error('failure lost completed counts');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.message+' '+error.stack;document.body.append(p);}
`);
			server.route("GET", "/hold", async () => { await new Promise((resolve) => setTimeout(resolve, 12_000)); return {}; });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({ url: `http://127.0.0.1:${port}/`, readySelector: "#ready", label: "Step count animations", isSolved: (p) => p.text.includes('id="ready">') });
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90_000,
);
