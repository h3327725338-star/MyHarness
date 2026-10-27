import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
const gated = process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length;

function newBrowser(root: string): LocalBrowser {
	return new LocalBrowser({
		kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
		rootDir: join(root, "browser"),
	});
}

function mountWebAssets(server: WebHttpServer): void {
	for (const dir of ["js", "vendor", "css"])
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
}

const STYLES = ["tokens", "base", "layout", "transcript", "composer", "overlays"]
	.map((name) => `<link rel="stylesheet" href="/css/${name}.css">`)
	.join("");

it.skipIf(gated)(
	"switches Coding/General at once while the other mode's lists still load, and reads them early when the page is idle",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-responsive-"));
		const server = new WebHttpServer();
		const browser = newBrowser(root);
		const requests: string[] = [];
		let generalReads = 0;
		const snapshot = (slot: string) => ({
			slot,
			mode: slot === "g1" ? "general" : "coding",
			session: { id: slot, file: `C:/fixture/${slot}.jsonl`, persisted: true, name: null },
			workspace: null,
			cwd: "C:/fixture",
			flags: {},
			queue: { steering: [], followUp: [] },
			dialogs: [],
			surface: { widgets: {}, statuses: {} },
			active: false,
		});
		const modes = {
			coding: { lastSessionFile: "C:/fixture/c1.jsonl", drafts: {} },
			general: { lastSessionFile: "C:/fixture/g1.jsonl", drafts: {} },
		};
		try {
			mountWebAssets(server);
			server.route("GET", "/api/test/requests", () => ({ requests }));
			server.route("GET", "/api/boot", () => ({ phase: "ready", detail: null, dialogs: [] }));
			server.route("GET", "/api/state", ({ req }) =>
				snapshot(String(req.headers["x-myharness-slot"] || "") || "c1"),
			);
			server.route("GET", "/api/transcript", () => ({ items: [] }));
			server.route("GET", "/api/slots", () => ({
				slots: ["c1", "g1"].map((slot) => ({
					slot,
					mode: slot === "g1" ? "general" : "coding",
					sessionFile: `C:/fixture/${slot}.jsonl`,
					sessionId: slot,
					cwd: "C:/fixture",
				})),
			}));
			server.route("GET", "/api/modes/state", () => modes);
			server.route("POST", "/api/modes/state", () => ({ state: modes.coding }));
			server.route("POST", "/api/modes/open", () => ({
				slot: "g1",
				created: false,
				mode: "general",
				state: modes.general,
			}));
			// The first read of the General lists (the page's early one) fails; the next one, made by the switch, is slow.
			server.route("GET", "/api/workspaces", async ({ url }) => {
				const general = url.searchParams.get("mode") === "general";
				requests.push(`GET /api/workspaces?mode=${general ? "general" : "coding"}`);
				if (!general)
					return {
						workspaces: [{ id: "wc", rootPath: "C:/proj-c", name: "proj-c", current: false }],
						currentPath: null,
					};
				generalReads += 1;
				if (generalReads === 1) throw new Error("not now");
				await new Promise((resolve) => setTimeout(resolve, 2000));
				return {
					workspaces: [{ id: "wg", rootPath: "C:/proj-g", name: "proj-g", current: false }],
					currentPath: null,
				};
			});
			server.route("GET", "/api/workspaces/sessions", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/api/git/status", async () => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				return { isRepository: true, branch: "main", root: "C:/fixture" };
			});
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 15000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				`<!doctype html>${STYLES}<div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>`,
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {boot,state,setView,switchChatMode,activeSlotId,loadGitStatus} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(ok,message)=>{ if(!ok) throw Error(message); };
const until=async(fn,ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(fn()) return; await wait(40); } throw Error('timed out waiting for the page'); };
const asked=async()=>(await (await fetch('/api/test/requests')).json()).requests;
try {
 setView({motion:'off',lang:'en',chatMode:'coding'}); document.documentElement.dataset.motion='off';
 boot();
 await until(()=>activeSlotId()==='c1'&&state.workspaces.loaded);
 // Once the first screen is ready, read the other mode immediately, without the former 1.2s delay.
 // This speculative read fails here; selecting General must retry independently.
 await loadGitStatus();
 await wait(1700);
 must(state.gitStatus?.branch==='main','initial Git status did not load');
 must((await asked()).filter(r=>r==='GET /api/workspaces?mode=general').length===1,'the other mode was not read ahead: '+JSON.stringify(await asked()));
 must(state.view.chatMode==='coding'&&!(await asked()).some(r=>r.startsWith('POST')),'reading ahead changed the page or opened something');
 // 3. The switch does not wait for lists that are still loading (the next General read takes two seconds): the knob
 // moves at once and the page shows General as soon as its chat is there.
 const t0=performance.now();
 const pending=switchChatMode('general');
 must(state.view.modeIntent==='general','the switch did not move at once');
 await pending;
 const took=performance.now()-t0;
 must(took<1000,'the switch waited for the lists: '+Math.round(took)+' ms');
 must(state.view.chatMode==='general'&&activeSlotId()==='g1','General is not on screen after the switch');
 must(state.gitStatus?.branch==='main','same-workspace chat lost its branch while reconciliation was pending');
 must(!state.workspaces.loaded,'the lists were already loaded, so the test did not exercise the wait');
 must((await asked()).filter(r=>r==='GET /api/workspaces?mode=general').length===2,'the switch did not ask for the General lists: '+JSON.stringify(await asked()));
 // 4. The lists fill in when they arrive.
 await until(()=>state.workspaces.loaded&&state.workspaces.list.some(w=>w.name==='proj-g'),6000);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Responsiveness: mode switch",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);

it.skipIf(gated)(
	"glides the height of Show more / Show all, tells the server when typed input was erased again and keeps those requests in order",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-responsive-"));
		const server = new WebHttpServer();
		const browser = newBrowser(root);
		const touched: unknown[] = [];
		let inflight = 0;
		let maxInflight = 0;
		try {
			mountWebAssets(server);
			server.route("POST", "/api/sessions/touched", async ({ body }) => {
				inflight += 1;
				maxInflight = Math.max(maxInflight, inflight);
				touched.push(body);
				await new Promise((resolve) => setTimeout(resolve, 150));
				inflight -= 1;
				return { ok: true };
			});
			server.route("GET", "/api/test/touched", () => ({ bodies: touched, maxInflight }));
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 15000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				`<!doctype html>${STYLES}<div id="side" style="width:280px;height:700px;display:flex;flex-direction:column"></div><div id="steps" style="width:520px"></div><div id="app" style="width:640px"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>`,
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {WebSteps} from '/js/tool-rows.js';
import {Composer} from '/js/composer.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(r));
const must=(ok,message)=>{ if(!ok) throw Error(message); };
// The height of a block on every frame for a while, counted from the moment this is called.
const heights=async(el,ms)=>{ const out=[]; const end=performance.now()+ms; while(performance.now()<end){ await frame(); out.push(Math.round(el().getBoundingClientRect().height)); } return out; };
const ordered=list=>list.every((value,i)=>!i||value>=list[i-1]);
const glides=(label,before,list)=>{
 const last=list.at(-1);
 must(last>before+80,label+' did not grow: '+before+' -> '+last);
 must(ordered(list),label+' did not grow steadily: '+list);
 const between=list.filter(value=>value>before+4&&value<last-4);
 must(between.length>=3,label+' appeared at once instead of gliding: '+list);
};
// A block that settles at a new height (taller or shorter) with the shared motion: steadily, through frames in between.
const settles=(label,before,list,target)=>{
 const last=list.at(-1);
 must(Math.abs(last-target)<=2&&Math.abs(target-before)>10,label+' did not settle at '+target+': '+before+' -> '+last);
 const sign=Math.sign(target-before);
 must(list.every((value,i)=>!i||(value-list[i-1])*sign>=0),label+' did not move steadily: '+list);
 must(list.filter(value=>Math.abs(value-before)>3&&Math.abs(value-last)>3).length>=3,label+' jumped instead of moving: '+list);
};
try {
 const side=document.getElementById('side');
 const chats=n=>Array.from({length:n},(_,i)=>({path:'C:/p/chat'+i+'.jsonl',id:'c'+i,name:'Chat '+i,firstMessage:'Chat '+i,modified:1000-i,messageCount:2,mode:'coding'}));
 const ws={list:[{id:'w',name:'proj',rootPath:'C:/project'}],sessions:{'C:/project':chats(20)},unbound:[],errors:{}};
 const mountSidebar=()=>{ render(null,side); setView({expanded:{'C:/project':true}}); render(h(Sidebar),side); };
 document.documentElement.dataset.motion='on'; setView({motion:'on',lang:'en'});
 set({workspaces:ws,activeSlot:'s',slots:[],snap:{session:{file:'C:/p/other.jsonl'},workspace:{id:'w',rootPath:'C:/project'}}});

 // 1. The sidebar's "Show N more": every chat is listed in a box twelve rows tall that scrolls inside (CHAT_ROWS_SHOWN),
 // and the group moves to that height with the shared motion instead of jumping.
 mountSidebar(); await wait(600);
 const group=()=>side.querySelector('.ws-children');
 must(side.querySelectorAll('.chat-row').length===12&&side.querySelector('.side-more'),'the group does not start with 12 chats and a button');
 let before=group().getBoundingClientRect().height;
 side.querySelector('.side-more').click();
 const rows=()=>side.querySelector('.chat-rows-capped');
 const shownRows=await heights(group,700);
 must(side.querySelectorAll('.chat-row').length===20&&!side.querySelector('.side-more'),'not all chats are listed after Show more');
 must(rows()&&rows().scrollHeight>rows().clientHeight+100,'the expanded group does not scroll inside its twelve-row box');
 settles('Show more in the sidebar',before,shownRows,Math.round(rows().getBoundingClientRect().height));
 must(getComputedStyle(group()).overflow==='visible','the group stayed clipped after the motion');
 // With animations off the same click shows everything at once.
 document.documentElement.dataset.motion='off'; setView({motion:'off'});
 mountSidebar(); await wait(300);
 before=group().getBoundingClientRect().height;
 side.querySelector('.side-more').click();
 const offRows=await heights(group,400);
 must(Math.abs(offRows.at(-1)-before)>10,'Show more in the sidebar changed nothing with animations off');
 must(!offRows.some(value=>Math.abs(value-before)>3&&Math.abs(value-offRows.at(-1))>3),'Show more in the sidebar moved although animations are off: '+offRows);
 document.documentElement.dataset.motion='on'; setView({motion:'on'});

 // 2. "Show all N" below a tool's results (the same motion for every Show all / Show more of the transcript).
 const results=Array.from({length:12},(_,i)=>({url:'https://example.test/'+i,title:'Result '+i,source:'web'}));
 const step={key:'k1',status:'done',verb:'Searched',target:'query',web:{search:true,returned:12,opened:0},result:{details:{results,pages:[],failures:[]}}};
 const steps=document.getElementById('steps');
 render(h(WebSteps,{actions:[step],rawFor:()=>null}),steps); await wait(300);
 const block=()=>steps.querySelector('.web-block');
 must(block().querySelectorAll('.web-item').length===6,'the results do not start with 6 entries');
 before=block().getBoundingClientRect().height;
 block().querySelector('.web-more').click();
 glides('Show all results',before,await heights(block,700));
 must(block().querySelectorAll('.web-item').length===12,'not all results are listed after Show all');
 // Showing less folds back the same way (the block shrinks steadily).
 const full=block().getBoundingClientRect().height;
 block().querySelector('.web-more').click();
 const shrink=await heights(block,700);
 must(shrink.at(-1)<full-80&&shrink.every((value,i)=>!i||value<=shrink[i-1]),'Show less did not fold back steadily: '+shrink);
 must(shrink.filter(value=>value<full-4&&value>shrink.at(-1)+4).length>=3,'Show less folded at once: '+shrink);
 render(null,steps);

 // 3. The composer: typed input is told to the server and so is erasing it again (a chat with nothing in it is a blank
 // chat like a new one); only changes are sent, white space is no input, and the requests of one chat never overlap.
 render(null,side);
 set({snap:{session:{id:'t1',file:'C:/p/t1.jsonl',persisted:true},flags:{},trust:{trusted:true},model:{id:'m',input:['text']}},activeSlot:'s1',gitStatus:null,resources:{commands:[]},items:[],dialogs:[],queue:{steering:[],followUp:[]},surface:{widgets:{},statuses:{}}});
 const app=document.getElementById('app');
 render(h(Composer,{}),app); await wait(250);
 const input=document.querySelector('.composer-input');
 const type=data=>{ input.focus(); input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data})); };
 const erase=count=>{ for(let i=0;i<count;i++) input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'deleteContentBackward'})); };
 const told=async()=>await (await fetch('/api/test/touched')).json();
 const bodies=async()=>JSON.stringify((await told()).bodies.map(body=>body.touched));
 // What must arrive is awaited (a request can land a little late on a busy machine); what must not is checked after a pause.
 const until=async want=>{ let got=await bodies(); for(const end=performance.now()+3000;got!==want&&performance.now()<end;){ await wait(30); got=await bodies(); } return got; };
 type('hi');
 const typed=await until('[true]');
 must(typed==='[true]','typing was not told: '+typed);
 type('!'); await wait(300);
 must(await bodies()==='[true]','more typing was told again: '+await bodies());
 erase(3);
 const erased=await until('[true,false]');
 must(erased==='[true,false]','erasing the input was not told: '+erased);
 type('   '); await wait(300);
 must(await bodies()==='[true,false]','white space counted as input: '+await bodies());
 erase(3); await wait(200);
 // Typed and erased again while the first request is still being answered: both arrive, in order, one after the other.
 type('a'); await wait(40); erase(1);
 const quick=await until('[true,false,true,false]');
 must(quick==='[true,false,true,false]','quick type and erase were not told in order: '+quick);
 must((await told()).maxInflight===1,'requests for one chat overlapped: '+(await told()).maxInflight);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Responsiveness: expanders and touched input",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
