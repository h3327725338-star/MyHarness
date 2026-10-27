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

const chat = (path: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({
	path,
	id,
	name,
	firstMessage: "hi",
	created: 1,
	modified: 2,
	messageCount: 5,
	blank: false,
	parentSessionPath: null,
	pinned: false,
	current: false,
	...extra,
});

/** The page-side harness shared by both scenarios: fetch recording, a manual idle queue, reporting, #ready. */
const PROLOGUE = `
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {boot,state,setView,activeSlotId} from '/js/store.js';
import {setLang} from '/js/lang.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(ok,msg)=>{ if(!ok) throw Error(msg); };
const until=async(fn,ms=8000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(fn()) return true; await wait(30); } throw Error('timed out waiting for: '+String(fn).slice(0,120)); };
const log=[];
const origFetch=window.fetch;
window.fetch=async(input,init)=>{
 const url=typeof input==='string'?input:(input&&input.url)||String(input);
 if(!url.startsWith('/api/')) return origFetch(input,init);
 const rec={url,start:performance.now(),end:null};
 log.push(rec);
 const res=await origFetch(input,init);
 try { await res.clone().text(); } catch {}
 rec.end=performance.now();
 return res;
};
// The deferred loads go through requestIdleCallback; the page takes it over so the test decides when the page is idle.
// The queue keeps the time each load was armed: arming must wait for the first-screen requests, not for the first quiet moment.
const idleCbs=[];
window.requestIdleCallback=(cb)=>{ idleCbs.push({cb,t:performance.now()}); return 1; };
const idle=()=>{ const cbs=idleCbs.splice(0); for (const e of cbs) e.cb({didTimeout:true,timeRemaining:()=>0}); };
const asked=(frag)=>log.filter(r=>r.url.includes(frag));
const codingUnbound=()=>asked('/api/sessions/unbound?mode=coding');
const codingArchived=()=>asked('/api/sessions/archived?mode=coding');
const endOf=(frag)=>{ const r=asked(frag).slice(-1)[0]; return r&&r.end; };
const geom=()=>[...document.querySelectorAll('.ws-row')].map(r=>({name:r.querySelector('.name')?.textContent||'?',top:Math.round(r.getBoundingClientRect().top),expanded:r.getAttribute('aria-expanded'),current:r.classList.contains('current')}));
const row=(name)=>[...document.querySelectorAll('.ws-row')].find(r=>r.querySelector('.name')?.textContent===name);
try {
 setLang('en');
 render(h(Sidebar,{}),app);
`;

const EPILOGUE = `
 await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:true,log})});
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch (error) {
 try { await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:false,error:String(error&&error.stack||error),log})}); } catch {}
 document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error&&error.message||error)+'</p>');
}
`;

it.skipIf(gated)(
	"waits for the first-screen requests before the unbound and archived lists, and loads them on idle or when General opens",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-boot-requests-"));
		const server = new WebHttpServer();
		const browser = newBrowser(root);
		const requests: string[] = [];
		let result: { ok: boolean; error?: string; log?: unknown[] } | undefined;
		try {
			mountWebAssets(server);
			server.mount({ prefix: "/test/", directory: root });
			server.route("GET", "/api/boot", () => ({ phase: "ready", detail: null, dialogs: [] }));
			server.route("GET", "/api/state", () => ({
				slot: "c1",
				mode: "coding",
				session: { id: "c1", file: "C:/proj-c/c1.jsonl", persisted: true, name: "Proj chat" },
				workspace: { id: "w1", rootPath: "C:/proj-c" },
				cwd: "C:/proj-c",
				flags: {},
				queue: { steering: [], followUp: [] },
				dialogs: [],
				surface: { widgets: {}, statuses: {} },
				active: false,
			}));
			server.route("GET", "/api/modes/state", () => ({
				coding: { lastSessionFile: "C:/proj-c/c1.jsonl", drafts: {} },
			}));
			server.route("POST", "/api/modes/state", () => ({ state: {} }));
			server.route("GET", "/api/transcript", async () => {
				await new Promise((resolve) => setTimeout(resolve, 250)); // the current chat is read while the sidebar data loads
				return { items: [] };
			});
			server.route("GET", "/api/slots", () => ({
				slots: [
					{
						slot: "c1",
						mode: "coding",
						sessionFile: "C:/proj-c/c1.jsonl",
						sessionId: "c1",
						cwd: "C:/proj-c",
						name: "Proj chat",
						hasContent: true,
						unbound: false,
						active: false,
					},
				],
			}));
			server.route("GET", "/api/workspaces", ({ url }) => {
				const general = url.searchParams.get("mode") === "general";
				requests.push(`GET /api/workspaces?mode=${general ? "general" : "coding"}`);
				return general
					? { workspaces: [], currentPath: null, currentSessionFile: null }
					: {
							workspaces: [{ id: "w1", name: "proj-c", rootPath: "C:/proj-c", current: true }],
							currentPath: "C:/proj-c",
							currentSessionFile: "C:/proj-c/c1.jsonl",
						};
			});
			server.route("GET", "/api/workspaces/sessions", ({ url }) => {
				requests.push(`GET /api/workspaces/sessions?path=${url.searchParams.get("path")}`);
				return {
					sessions:
						url.searchParams.get("path") === "C:/proj-c"
							? [chat("C:/proj-c/c1.jsonl", "c1", "Proj chat", { current: true })]
							: [],
				};
			});
			server.route("GET", "/api/sessions/unbound", async ({ url }) => {
				const general = url.searchParams.get("mode") === "general";
				requests.push(`GET /api/sessions/unbound?mode=${general ? "general" : "coding"}`);
				await new Promise((resolve) => setTimeout(resolve, 150));
				return { sessions: general ? [] : [chat("C:/fixture/u1.jsonl", "u1", "Unbound chat")] };
			});
			server.route("GET", "/api/sessions/archived", async ({ url }) => {
				const general = url.searchParams.get("mode") === "general";
				requests.push(`GET /api/sessions/archived?mode=${general ? "general" : "coding"}`);
				await new Promise((resolve) => setTimeout(resolve, 150));
				return { sessions: general ? [] : [chat("C:/fixture/a1.jsonl", "a1", "Old archived chat")] };
			});
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/test-result", ({ body }) => {
				result = body as typeof result;
				return {};
			});
			writeFileSync(
				join(root, "index.html"),
				`<!doctype html>${STYLES}<div id="app" style="width:300px"></div><script type="module" src="/test/test.js"></script>`,
			);
			writeFileSync(
				join(root, "test.js"),
				`${PROLOGUE}
 setView({motion:'off',lang:'en',chatMode:'coding',expanded:{'<general>':false}});
 boot();
 await until(()=>activeSlotId()==='c1'&&state.workspaces.loaded&&endOf('/api/transcript'));
 const wsEnd=endOf('/api/workspaces?mode=coding'), trEnd=endOf('/api/transcript');
 must(wsEnd!==undefined&&trEnd!==undefined,'first-screen requests did not finish');
 // 1. While the page is booting, neither slow list is asked for at all.
 must(codingUnbound().length===0&&codingArchived().length===0,'a full-scan list was asked for during the first screen: '+JSON.stringify(log.map(r=>r.url)));
 must(!geom().some(r=>r.name==='Archived chats'),'the archived group appeared before its list loaded');
 // 2. Opening General reads its list right away (the sidebar's own expand path, not the idle timer).
 const clickT=performance.now();
 row('Default').click();
 await until(()=>codingUnbound().length===1);
 const u=codingUnbound()[0];
 must(u.start-clickT<300,'opening General did not load the unbound list at once: '+Math.round(u.start-clickT)+' ms late');
 must(u.start>=wsEnd&&u.start>=trEnd,'the unbound list started before the first-screen requests finished');
 await until(()=>[...document.querySelectorAll('.chat-row')].some(r=>r.textContent.includes('Unbound chat')));
 const before=geom(); // the Workspace row and the (now open) Default group, before the archived list exists
 must(before.length===2&&before.some(r=>r.name==='proj-c')&&before.some(r=>r.name==='Default'),'unexpected groups before the archived list: '+JSON.stringify(before));
 // 3. The archived list waits until the page is quiet; the test decides when that is (idle stub).
 await wait(300);
 must(codingArchived().length===0,'the archived list loaded while the page was never idle');
 // The deferred asks are only armed once the first screen's requests are done: a quiet main thread also happens
 // while those are still in flight, and arming then would let the slow scans race the first screen on the server.
 const sessEnd=endOf('/api/workspaces/sessions');
 must(idleCbs.length>=1&&idleCbs.every(e=>e.t>=wsEnd&&e.t>=sessEnd),'a deferred list was armed before the first-screen requests finished: '+JSON.stringify({wsEnd,sessEnd,arms:idleCbs.map(e=>Math.round(e.t))}));
 idle();
 await until(()=>codingArchived().length===1);
 const a=codingArchived()[0];
 must(a.start>=wsEnd&&a.start>=trEnd&&a.start>=u.end,'the archived list raced the first-screen requests: '+JSON.stringify({wsEnd,trEnd,uEnd:u.end,aStart:a.start}));
 await until(()=>codingArchived()[0].end!==null);
 await wait(150);
 // 4. When the archived list arrives nothing in the sidebar moves or resets: same places, same open and current marks.
 //    Archived chats have no group in the sidebar.
 const after=geom();
 const byName=new Map(after.map(r=>[r.name,r]));
 for (const r of before) {
   const now=byName.get(r.name);
   must(now,'group vanished when the archived list arrived: '+r.name);
   must(Math.abs(now.top-r.top)<=2,'group moved when the archived list arrived: '+r.name+' by '+(now.top-r.top)+' px');
   must(now.expanded===r.expanded,'open state reset when the archived list arrived: '+r.name+' '+r.expanded+'->'+now.expanded);
   must(now.current===r.current,'current mark reset when the archived list arrived: '+r.name);
 }
 must(after.length===before.length&&!row('Archived chats'),'the sidebar grew a group when the archived list arrived: '+JSON.stringify(after));
 must(![...document.querySelectorAll('.chat-row')].some(r=>r.textContent.includes('Old archived chat')),'an archived chat is listed in the sidebar');
 must([...document.querySelectorAll('.chat-row')].filter(r=>r.textContent.includes('Unbound chat')).length===1,'the unbound chat listed twice');
 // 5. The idle queue is consumed once: the loaded lists are not asked for a second time.
 idle();
 await wait(250);
 must(codingUnbound().length===1&&codingArchived().length===1,'a deferred list was asked for twice: '+JSON.stringify(log.map(r=>r.url)));
${EPILOGUE}`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Boot requests: deferred lists",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(result?.ok, `${page.text}\nserver saw: ${JSON.stringify(requests)}`).toBe(true);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);

it.skipIf(gated)(
	"loads the unbound list at once for an open General group or an unbound chat on screen, and keeps its highlight",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-boot-unbound-"));
		const server = new WebHttpServer();
		const browser = newBrowser(root);
		let result: { ok: boolean; error?: string; log?: unknown[] } | undefined;
		try {
			mountWebAssets(server);
			server.mount({ prefix: "/test/", directory: root });
			server.route("GET", "/api/boot", () => ({ phase: "ready", detail: null, dialogs: [] }));
			server.route("GET", "/api/state", () => ({
				slot: "u1",
				mode: "coding",
				session: { id: "u1", file: "C:/fixture/u1.jsonl", persisted: true, name: "Unbound current" },
				workspace: null,
				cwd: "C:/proj-c",
				flags: {},
				queue: { steering: [], followUp: [] },
				dialogs: [],
				surface: { widgets: {}, statuses: {} },
				active: false,
			}));
			server.route("GET", "/api/modes/state", () => ({
				coding: { lastSessionFile: "C:/fixture/u1.jsonl", drafts: {} },
			}));
			server.route("POST", "/api/modes/state", () => ({ state: {} }));
			server.route("GET", "/api/transcript", async () => {
				await new Promise((resolve) => setTimeout(resolve, 250));
				return { items: [] };
			});
			server.route("GET", "/api/slots", () => ({
				slots: [
					{
						slot: "u1",
						mode: "coding",
						sessionFile: "C:/fixture/u1.jsonl",
						sessionId: "u1",
						cwd: "C:/proj-c",
						name: "Unbound current",
						hasContent: true,
						unbound: true,
						active: false,
					},
				],
			}));
			// No workspace holds the chat on screen: the Default group is its group.
			server.route("GET", "/api/workspaces", ({ url }) => ({
				workspaces: [],
				currentPath: url.searchParams.get("mode") === "coding" ? "C:/proj-c" : null,
				currentSessionFile: "C:/fixture/u1.jsonl",
			}));
			server.route("GET", "/api/workspaces/sessions", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/unbound", async ({ url }) => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return {
					sessions:
						url.searchParams.get("mode") === "general"
							? []
							: [chat("C:/fixture/u1.jsonl", "u1", "Unbound current", { current: true })],
				};
			});
			server.route("GET", "/api/sessions/archived", async ({ url }) => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return {
					sessions:
						url.searchParams.get("mode") === "general"
							? []
							: [chat("C:/fixture/a1.jsonl", "a1", "Old archived chat")],
				};
			});
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/test-result", ({ body }) => {
				result = body as typeof result;
				return {};
			});
			writeFileSync(
				join(root, "index.html"),
				`<!doctype html>${STYLES}<div id="app" style="width:300px"></div><script type="module" src="/test/test.js"></script>`,
			);
			writeFileSync(
				join(root, "test.js"),
				`${PROLOGUE}
 setView({motion:'off',lang:'en',chatMode:'coding'}); // the Default group is open as on every fresh page
 boot();
 await until(()=>activeSlotId()==='u1'&&state.workspaces.loaded&&endOf('/api/workspaces?mode=coding'));
 const wsEnd=endOf('/api/workspaces?mode=coding'), trEnd=endOf('/api/transcript');
 // 1. General is open: its list is asked for the moment the Workspaces arrive, without waiting for a quiet page.
 await until(()=>codingUnbound().length===1);
 const u=codingUnbound()[0];
 must(u.start-wsEnd<150,'the unbound list waited behind the page instead of loading with the open General group: '+Math.round(u.start-wsEnd)+' ms');
 // 2. The chat on screen belongs to no workspace: its row is marked as the current one and the Default group is the current group.
 await until(()=>!!document.querySelector('.chat-row.current')&&[...document.querySelectorAll('.chat-row')].some(r=>r.classList.contains('current')&&r.textContent.includes('Unbound current')));
 const genRow=row('Default');
 must(genRow?.classList.contains('current'),'the Default group lost the current mark for an unbound chat on screen');
 must(genRow?.getAttribute('aria-expanded')==='true','the open General group closed itself');
 // 3. The archived list still waits for the page to be quiet, and never overtakes the first-screen requests.
 await wait(300);
 must(codingArchived().length===0,'the archived list loaded while the page was never idle');
 // It is armed only once the first screen's requests are done (a quiet main thread also happens while they are in flight).
 must(idleCbs.length>=1&&idleCbs.every(e=>e.t>=wsEnd&&e.t>=u.end),'the deferred archived list was armed before the first-screen requests finished: '+JSON.stringify({wsEnd,uEnd:u.end,arms:idleCbs.map(e=>Math.round(e.t))}));
 const before=geom();
 idle();
 await until(()=>codingArchived().length===1);
 const a=codingArchived()[0];
 must(a.start>=wsEnd&&a.start>=trEnd&&a.start>=u.end,'the archived list raced the first-screen requests: '+JSON.stringify({wsEnd,trEnd,uEnd:u.end,aStart:a.start}));
 await until(()=>codingArchived()[0].end!==null);
 await wait(150);
 const after=geom();
 must(after.length===before.length&&!row('Archived chats'),'the sidebar grew a group when the archived list arrived: '+JSON.stringify(after));
 for (const r of before) {
   const now=after.find(x=>x.name===r.name);
   must(now&&Math.abs(now.top-r.top)<=2&&now.expanded===r.expanded&&now.current===r.current,'sidebar shifted or reset when the archived list arrived: '+r.name);
 }
 must(!!document.querySelector('.chat-row.current'),'the current chat highlight was lost');
${EPILOGUE}`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Boot requests: open General loads at once",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(result?.ok, page.text).toBe(true);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
