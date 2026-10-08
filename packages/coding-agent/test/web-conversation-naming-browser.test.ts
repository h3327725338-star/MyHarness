import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows unobtrusive naming progress and a keyboard-accessible failure retry in the sidebar",
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
 let el=document.querySelector('.naming-status');
 if(!el) throw Error('naming shows no indicator');
 if(el.tagName==='BUTTON') throw Error('naming in progress is still a button');
 if(!el.querySelector('svg.spinner')) throw Error('naming progress has no working ring');
 if(!noText(el)) throw Error('naming ring carries inline text');
 if(!el.querySelector('svg.spinner title')?.textContent.includes('命名中')) throw Error('missing naming tooltip');
 set({slots:[{...slot,conversationNaming:{phase:'retrying',retries:2,error:'No available conversation naming model. Check the assistant model settings.'}}]});await wait(50);
 el=document.querySelector('.naming-status');
 const tip=el?.querySelector('svg.spinner title')?.textContent||'';
 if(!tip.includes('命名重试 2/3')||!tip.includes('命名模型不可用')) throw Error('missing localized retry information in tooltip');
 if(!noText(el)) throw Error('retry ring carries inline text');
 set({slots:[{...slot,conversationNaming:{phase:'failed',retries:3,error:'No available conversation naming model. Check the assistant model settings.'}}]});await wait(50);
 el=document.querySelector('.naming-status');
 if(el?.tagName!=='BUTTON'||el.disabled||!el.getAttribute('aria-label').includes('点击重新尝试')) throw Error('failure retry is inaccessible');
 if(!noText(el)) throw Error('failed naming still shows inline text');
 if(el.className.includes('warn')) throw Error('failed naming is colored as a warning');
 if(getComputedStyle(el).opacity!=='1'||el.getBoundingClientRect().width<12) throw Error('failure retry is invisible');
 el.focus();el.click();await wait(100);
 set({slots:[{...slot,conversationNaming:null}]});await wait(50);
 if(document.querySelector('.naming-status')) throw Error('success did not clear status');
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
