import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps retry progress on one line with expandable error details, shows a one-line cancel button and keeps the time visible while the status ring turns at the head of the row",
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
import {activateSlot,canSendToActive,set,setView,state,GENERAL_KEY} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sent=[];
try {
 setView({lang:'zh-CN',motion:'off',chatMode:'coding',expanded:{[GENERAL_KEY]:true}});
 // 1) The provider-retry strip: the cancel control stays on one line, framed, centered with the text.
 const snap={active:false,trust:{trusted:true},flags:{},queue:{steering:[],followUp:[]},model:null,thinking:{levels:[]}};
 set({snap,queue:{steering:[],followUp:[]}});
 set({retry:{attempt:2,maxAttempts:3,delayMs:60000,at:Date.now(),errorMessage:'x'.repeat(200)}});
 render(h(Composer),document.getElementById('app'));await wait(150);
 const strip=document.querySelector('.strip-retry');
 if(!strip) throw Error('retry strip missing');
 const btn=strip.querySelector('.link-btn'), main=strip.querySelector('.strip-main');
 const cs=getComputedStyle(btn);
 if(btn.textContent.trim()!=='取消重试') throw Error('cancel button label');
 if(cs.whiteSpace!=='nowrap'||cs.flexShrink==='1'&&getComputedStyle(btn).flexGrow!=='0') throw Error('cancel button can wrap');
 if(!cs.borderTopWidth.startsWith('1')&&parseFloat(cs.borderTopWidth)<1) throw Error('cancel button has no frame');
 if(cs.backgroundColor==='rgba(0, 0, 0, 0)'||cs.backgroundColor==='transparent') throw Error('cancel button has no soft surface');
 if(cs.color!==getComputedStyle(strip).color) throw Error('cancel button color fights the strip');
 const br=btn.getBoundingClientRect(), sr=strip.getBoundingClientRect();
 if(br.height>=sr.height||br.height<18) throw Error('cancel button is not a compact single line');
 if(Math.abs(br.top+br.height/2-(sr.top+sr.height/2))>2) throw Error('cancel button is not vertically centered');
 // One line: countdown, attempt count and a short cause — no ellipsis, no long error text; the full error is the tooltip.
 const status=strip.querySelector('.strip-status'), reason=strip.querySelector('.strip-reason');
 if(!status.textContent.endsWith('秒后重试 2/3')) throw Error('status text: '+status.textContent);
 if(reason.textContent!=='请求失败') throw Error('reason text: '+reason.textContent);
 if(status.scrollWidth>status.clientWidth||reason.scrollWidth>reason.clientWidth) throw Error('status line is truncated');
 if(strip.textContent.includes('xxxx')) throw Error('long error leaks into the one-line status');
 if(main.title!=='x'.repeat(200)) throw Error('full error missing from tooltip');
 if(br.left-main.getBoundingClientRect().right<6) throw Error('cancel button has no gap from the text');
 const oneLine=sr.height;
 main.click();await wait(100);
 const detailText=strip.querySelector('.strip-detail-text');
 if(!detailText||detailText.textContent!=='x'.repeat(200)||main.getAttribute('aria-expanded')!=='true') throw Error('click does not open the error details');
 if(Math.abs(btn.getBoundingClientRect().height-br.height)>1) throw Error('cancel button deforms when details open');
 main.click();await wait(100);
 if(strip.querySelector('.strip-detail-text')||strip.getBoundingClientRect().height!==oneLine) throw Error('details did not close');
 // The category from the backend names the cause; the text guess is only the fallback for an unclassified error.
 for (const [category,label] of [['connect_timeout','建连超时'],['connect_failed','无法连接'],['first_byte_timeout','首包超时'],['stream_idle_timeout','静默超时'],['disconnect','连接断开'],['rate_limited','请求限流'],['upstream_overloaded','上游过载'],['other','请求失败']]) {
  set({retry:{attempt:2,maxAttempts:2,delayMs:2000,at:Date.now(),errorMessage:'Request timed out.',errorCategory:category}});
  await wait(120);
  const s=document.querySelector('.strip-retry');
  if(s.querySelector('.strip-reason').textContent!==(category==='other'?'请求超时':label)) throw Error('reason for '+category+': '+s.querySelector('.strip-reason').textContent);
  if(!s.querySelector('.strip-status').textContent.endsWith('秒后重试 2/2')) throw Error('status for '+category+': '+s.querySelector('.strip-status').textContent);
 }
 // After the cap the strip names the fallback model it switched to.
 set({retry:null,fallbackTo:'backup/backup-model'});
 await wait(120);
 if(!document.querySelector('.strip')?.textContent.includes('已切换到 backup/backup-model')) throw Error('fallback strip missing: '+document.body.textContent);
 set({fallbackTo:null});
 set({retry:null});
 // 2) Sidebar: the running ring sits at the head of the row, the time stays visible the whole time, and a naming that
 //    runs next to the task breathes inside the very same head slot (never a second ring beside the time).
 const path='C:/test/chat.jsonl';
 const slot={mode:'coding',slot:'one',sessionFile:path,sessionId:'chat',cwd:'C:/test',name:'测试对话',hasContent:true,unbound:true,active:false,completion:false};
 set({workspaces:{list:[],sessions:{},unbound:[{id:'chat',path,name:'测试对话',messageCount:2,modified:Date.now()-60000}],archived:[],errors:{},loaded:true},slots:[{...slot,active:true,conversationNaming:{phase:'processing',retries:0}}]});
 render(h(Sidebar,{}),document.getElementById('app'));await wait(150);
 let row=document.querySelector('.chat-row');
 if(!row.querySelector('.when')) throw Error('time hidden while the chat runs');
 if(!row.querySelector('.chat-ind .ind-ring svg.spinner')) throw Error('no working ring at the head while the chat runs');
 if(!row.querySelector('.chat-ind .ind-dot')) throw Error('no breathing dot while naming runs next to the task');
 // Naming ends on its own: the dot fades out of the slot, the ring keeps turning, the time never moved.
 set({slots:[{...slot,active:true}]});await wait(300);
 row=document.querySelector('.chat-row');
 if(row.querySelector('.chat-ind .ind-dot')) throw Error('naming dot still shown after naming ended');
 if(!row.querySelector('.chat-ind .ind-ring svg.spinner')) throw Error('ring lost when only naming ended');
 // The run ends too: the ring stops and fades out; the time was there all along.
 set({slots:[{...slot}]});await wait(300);
 row=document.querySelector('.chat-row');
 if(row.querySelector('.chat-ind .ind-ring')) throw Error('ring still shown after the run ended');
 if(!row.querySelector('.when')) throw Error('time missing after the run ended');
 // 3) The outcome banner's Retry: it must not re-send the original task (which restarts the work), but a continue
 //    instruction that picks the task up from its current state.
 //    Retry sends to the chat on screen, so a loaded chat is opened first (sends stay locked until its reads land).
 window.fetch=async(url,init)=>{
  const u=String(url);
  if(init?.method==='POST')sent.push({path:u,body:init.body??''});
  const body=u==='/api/state'?{...snap,slot:'one',mode:'coding',cwd:'C:/test',session:{id:'chat',file:path,name:'测试对话',persisted:true},dialogs:[],surface:{widgets:{},statuses:{}},run:{},app:{}}
   :u.startsWith('/api/transcript')?{items:[]}
   :u==='/api/slots'?{slots:[]}
   :u.startsWith('/api/workspaces')?{workspaces:[],sessions:[]}
   :u.includes('unbound')||u.includes('archived')?{sessions:[]}
   :u==='/api/resources'?{commands:[],tools:[],skills:[],templates:[],extensions:[]}
   :{};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 };
 await activateSlot('one');
 if(!canSendToActive()) throw Error('the chat did not finish opening');
 sent.length=0;
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
