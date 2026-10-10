import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows the naming state as one breathing dot at the head of the sidebar row (concentric with the running ring) and a keyboard-accessible failure retry",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		if (!artifacts) throw new Error("MYHARNESS_ARTIFACTS_DIR is required");
		mkdirSync(join(artifacts, "tests"), { recursive: true });
		const root = mkdtempSync(join(artifacts, "tests", "conversation-naming-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let retried = false;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("POST", "/api/sessions/naming-retry", ({ body }) => {
				retried = (body as any).path === "C:/test/chat.jsonl";
				return { ok: true };
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {set,setView,state,GENERAL_KEY} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 setView({lang:'zh-CN',motion:'off',chatMode:'coding',expanded:{[GENERAL_KEY]:true}});
 const path='C:/test/chat.jsonl';
 const slot={mode:'coding',slot:'one',sessionFile:path,sessionId:'chat',cwd:'C:/test',name:'测试对话',hasContent:true,unbound:true,active:false,completion:false};
 set({workspaces:{list:[],sessions:{},unbound:[{id:'chat',path,name:'测试对话',messageCount:2,modified:Date.now()}],archived:[],errors:{},loaded:true},slots:[{...slot,conversationNaming:{phase:'processing',retries:0}}]});
 const noText=n=>![...n.childNodes].some(x=>x.nodeType===3&&x.textContent.trim());
 render(h(Sidebar,{}),document.getElementById('app'));await wait(150);
 let dot=document.querySelector('.chat-ind .ind-dot');
 if(!dot) throw Error('naming shows no breathing dot');
 if(dot.tagName==='BUTTON') throw Error('naming in progress is still a button');
 if(!noText(dot)) throw Error('naming dot carries inline text');
 if(!dot.getAttribute('title')?.includes('命名中')) throw Error('missing naming tooltip');
 if(document.querySelector('.chat-ind .ind-ring')) throw Error('naming alone shows a running ring');
 set({slots:[{...slot,conversationNaming:{phase:'retrying',retries:2,error:'No available conversation naming model. Check the assistant model settings.'}}]});await wait(150);
 dot=document.querySelector('.chat-ind .ind-dot');
 const tip=dot?.getAttribute('title')||'';
 if(!tip.includes('命名重试 2/3')||!tip.includes('命名模型不可用')) throw Error('missing localized retry information in tooltip');
 if(!noText(dot)) throw Error('retry dot carries inline text');
 set({slots:[{...slot,conversationNaming:{phase:'failed',retries:3,error:'No available conversation naming model. Check the assistant model settings.'}}]});await wait(300);
 if(document.querySelector('.chat-ind .ind-dot')) throw Error('failed naming still shows the breathing dot');
 const btn=document.querySelector('.chat-ind .ind-retry');
 if(!btn||btn.tagName!=='BUTTON'||btn.disabled||!btn.getAttribute('aria-label').includes('点击重新尝试')) throw Error('failure retry is inaccessible');
 if(!noText(btn)) throw Error('failed naming still shows inline text');
 if(btn.className.includes('warn')) throw Error('failed naming is colored as a warning');
 if(getComputedStyle(btn).opacity!=='1'||btn.getBoundingClientRect().width<12) throw Error('failure retry is invisible');
 btn.focus();btn.click();await wait(100);
 set({slots:[{...slot,conversationNaming:null}]});await wait(300);
 if(document.querySelector('.chat-ind .ind-retry')||document.querySelector('.chat-ind .ind-dot')) throw Error('success did not clear status');
 // Both at once: the outer ring turns for the task while the inner dot breathes for the naming, in one shared slot,
 // concentric, at the head of the row (before the title), and the update time stays visible at the end of the row.
 set({slots:[{...slot,active:true,conversationNaming:{phase:'processing',retries:0}}]});await wait(150);
 const row=document.querySelector('.chat-row');
 const ringEl=row.querySelector('.chat-ind .ind-ring svg.spinner');
 const dotEl=row.querySelector('.chat-ind .ind-dot');
 if(!ringEl) throw Error('no outer ring while the task runs');
 if(!dotEl) throw Error('no inner dot while naming runs at the same time');
 if(!row.querySelector('.when')) throw Error('time crowded out while both states show');
 const rc=ringEl.getBoundingClientRect(), dc=dotEl.getBoundingClientRect(), tc=row.querySelector('.title').getBoundingClientRect(), wc=row.querySelector('.when').getBoundingClientRect();
 if(Math.abs(rc.left+rc.width/2-(dc.left+dc.width/2))>1.5||Math.abs(rc.top+rc.height/2-(dc.top+dc.height/2))>1.5) throw Error('inner dot is not concentric with the outer ring');
 if(dc.right>rc.right||dc.left<rc.left) throw Error('the dot does not sit inside the ring');
 if(ringEl.closest('.chat-ind').getBoundingClientRect().right>tc.left) throw Error('the indicator is not at the head of the row, before the title');
 if(wc.left<tc.right) throw Error('the time does not stay at the end of the row');
 // A failed naming while the task runs: the ring keeps the slot alone (naming cannot process during a run anyway);
 // once the row is quiet again the clickable retry takes its place.
 set({slots:[{...slot,active:true,conversationNaming:{phase:'failed',retries:3}}]});await wait(300);
 if(document.querySelector('.chat-ind .ind-retry')) throw Error('retry button crowds the ring while the task runs');
 if(!document.querySelector('.chat-ind .ind-ring svg.spinner')) throw Error('ring lost on failed naming while running');
 set({slots:[{...slot,conversationNaming:{phase:'failed',retries:3}}]});await wait(300);
 if(!document.querySelector('.chat-ind .ind-retry')) throw Error('retry button did not come back when the run ended');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Conversation naming sidebar test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			expect(retried).toBe(true);
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	60000,
);
