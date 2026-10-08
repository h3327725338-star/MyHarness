import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps retry progress, shows a one-line cancel button and hides the time while a chat runs",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		if (!artifacts) throw new Error("MYHARNESS_ARTIFACTS_DIR is required");
		mkdirSync(join(artifacts, "tests"), { recursive: true });
		const root = mkdtempSync(join(artifacts, "tests", "retry-sidebar-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const prompts: { path: string; body: string }[] = [];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			// Real endpoint for the sidebar's naming retry POST and for the captured prompts.
			server.route("POST", "/api/prompt", ({ body }) => {
				prompts.push({ path: "/api/prompt", body: JSON.stringify(body) });
				return { ok: true };
			});
			server.route("POST", "/api/sessions/naming-retry", () => ({ ok: true }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="app" style="width:340px"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {Sidebar} from '/js/sidebar.js';
import {actions} from '/js/actions.js';
import {set,setView,state,GENERAL_KEY} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sent=[];
try {
 setView({lang:'zh-CN',motion:'off',chatMode:'coding',expanded:{[GENERAL_KEY]:true}});
 // 1) The provider-retry strip: the cancel control stays on one line, framed, centered with the text.
 const snap={active:false,trust:{trusted:true},flags:{},queue:{steering:[],followUp:[]},model:null,thinking:{levels:[]}};
 set({snap,queue:{steering:[],followUp:[]}});
 set({retry:{attempt:2,maxAttempts:3,delayMs:60000,at:Date.now(),errorMessage:'x'.repeat(200)}});
 render(h(Composer),document.getElementById('app'));await wait(150);
 const strip=[...document.querySelectorAll('.strip')].find(n=>n.querySelector('button')&&n.textContent.includes('Provider'));
 if(!strip) throw Error('retry strip missing');
 const btn=strip.querySelector('button'), msg=strip.querySelector('span:last-of-type')||[...strip.querySelectorAll('span')].find(s=>s.textContent.length>10);
 const cs=getComputedStyle(btn);
 if(cs.whiteSpace!=='nowrap'||cs.flexShrink==='1'&&getComputedStyle(btn).flexGrow!=='0') throw Error('cancel button can wrap');
 if(!cs.borderTopWidth.startsWith('1')&&parseFloat(cs.borderTopWidth)<1) throw Error('cancel button has no frame');
 if(cs.backgroundColor==='rgba(0, 0, 0, 0)'||cs.backgroundColor==='transparent') throw Error('cancel button has no soft surface');
 if(cs.color!==getComputedStyle(strip).color) throw Error('cancel button color fights the strip');
 const br=btn.getBoundingClientRect(), sr=strip.getBoundingClientRect();
 if(br.height>=sr.height||br.height<18) throw Error('cancel button is not a compact single line');
 if(Math.abs(br.top+br.height/2-(sr.top+sr.height/2))>2) throw Error('cancel button is not vertically centered');
 const mcs=getComputedStyle(msg);
 if(mcs.whiteSpace!=='nowrap') throw Error('strip text can wrap and squeeze the button');
 if(msg.scrollWidth<=msg.clientWidth) throw Error('long text should ellipsize, not push the button');
 set({retry:null});
 // 2) Sidebar: a running chat shows only the spinning ring — no time text — and the time comes back after it stops.
 const path='C:/test/chat.jsonl';
 const slot={mode:'coding',slot:'one',sessionFile:path,sessionId:'chat',cwd:'C:/test',name:'测试对话',hasContent:true,unbound:true,active:false,completion:false};
 set({workspaces:{list:[],sessions:{},unbound:[{id:'chat',path,name:'测试对话',messageCount:2,modified:Date.now()-60000}],archived:[],errors:{},loaded:true},slots:[{...slot,active:true}]});
 render(h(Sidebar,{}),document.getElementById('app'));await wait(150);
 let row=document.querySelector('.chat-row');
 if(row.querySelector('.when')) throw Error('time still shown while the chat runs');
 if(!row.querySelector('.slot-status svg.spinner')) throw Error('no working ring while the chat runs');
 set({slots:[{...slot,active:false}]});await wait(150);
 row=document.querySelector('.chat-row');
 if(row.querySelector('.slot-status svg.spinner')) throw Error('ring still shown after the run ended');
 if(!row.querySelector('.when')) throw Error('time did not come back after the run ended');
 // 3) The outcome banner's Retry: it must not re-send the original task (which restarts the work), but a continue
 //    instruction that picks the task up from its current state.
 window.fetch=async(url,init)=>{if(init?.method==='POST')sent.push({path:String(url),body:init.body??''});return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
 state.snap={...snap,active:true};
 await actions.retry();
 if(sent.length) throw Error('retry sent a prompt while a run is active');
 state.snap={...snap,active:false};
 await actions.retry();
 const prompts=sent.filter(p=>p.path.includes('/api/prompt'));
 if(prompts.length!==1) throw Error('retry did not send exactly one prompt');
 const body=JSON.parse(prompts[0].body);
 if(!body.text||body.text.length>400||body.text.startsWith('Implement the whole feature')) throw Error('retry re-sent the original task instead of continuing');
 if(!body.text.includes('请从中断处继续')) throw Error('retry does not carry the continue instruction');
 if(body.images!==undefined) throw Error('retry re-attached the old images');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Retry strip, sidebar status and continue retry test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			const verdict = /id="ready">([^<]*)</.exec(page.text)?.[1] ?? "no ready marker";
			expect(verdict).toBe("passed");
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	60000,
);
