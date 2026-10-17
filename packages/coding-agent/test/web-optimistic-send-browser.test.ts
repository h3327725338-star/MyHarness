import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { HttpError } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

it("renders immediately in both modes, reconciles by id and restores rejected drafts in a real browser", async () => {
	const installed = detectInstalledBrowsers();
	expect(installed.length).toBeGreaterThan(0);
	const root = join(process.env.MYHARNESS_TEMP_DIR!, `optimistic-browser-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	const server = new WebHttpServer();
	const browser = new LocalBrowser({
		kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
		rootDir: join(root, "browser"),
	});
	try {
		for (const dir of ["js", "vendor", "css"])
			server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
		const snap = {
			slot: "test",
			mode: "coding",
			session: { id: "chat", file: "test.jsonl" },
			flags: {},
			active: false,
			model: { id: "test", name: "Test", input: ["text"] },
			dialogs: [],
			surface: { widgets: {} },
			queue: { steering: [], followUp: [] },
		};
		server.route("GET", "/api/boot", () => ({ phase: "ready" }));
		server.route("GET", "/api/state", () => snap);
		server.route("GET", "/api/transcript", () => ({
			items: Array.from({ length: 200 }, (_, index) => ({
				kind: "user",
				text: `old-${index}`,
				id: `old-${index}`,
				ts: index,
			})),
		}));
		server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
		server.route("GET", "/api/slots", () => ({ slots: [] }));
		server.route("GET", "/api/models", () => ({ models: [] }));
		server.route("GET", "/api/resources", () => ({ commands: [] }));
		server.route("POST", "/api/modes/state", () => ({ ok: true }));
		server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
		server.route("POST", "/api/seen", () => ({ ok: true }));
		server.route("POST", "/api/prompt", async ({ body }) => {
			const input = body as { text: string; clientMessageId: string };
			await new Promise((resolve) => setTimeout(resolve, 700));
			if (input.text.includes("reject")) throw new HttpError(400, "Rejected for test");
			server.broadcast("message_start", {
				slot: "test",
				clientMessageId: input.clientMessageId,
				item: { kind: "user", text: `server:${input.text}`, ts: Date.now() },
			});
			return { ok: true };
		});
		server.mount({ prefix: "/test/", directory: root });
		writeFileSync(
			join(root, "index.html"),
			'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
		);
		writeFileSync(
			join(root, "test.js"),
			`
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {boot,state,useStore,setView,canSendToActive} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async fn=>{for(let i=0;i<150;i++){if(fn())return;await wait(30)}throw Error('timeout')};
function App(){const items=useStore(s=>s.items);return h('div',{},h('div',{id:'messages'},items.map((i,n)=>h('p',{key:i.id||i.clientMessageId||n},i.text))),h(Composer));}
try {
 await boot();await until(()=>state.connected&&canSendToActive());render(h(App),document.getElementById('app'));await wait(100);
 const timings=[];
 for(const mode of ['general','coding']){
  setView({chatMode:mode});await wait(80);
  for(const failure of [false,true]){
   const text=mode+(failure?'-reject':'-send');const el=document.querySelector('.draft');el.focus();el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));await wait(40);
   const start=performance.now();el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
   await until(()=>state.items.some(i=>i.pending&&i.text===text));await new Promise(requestAnimationFrame);
   const elapsed=performance.now()-start;timings.push({mode,failure,elapsed});check(elapsed<100,'slow optimistic render: '+elapsed);check(document.querySelector('.draft').textContent==='','composer not cleared');
   await wait(900);
   check(!state.items.some(i=>i.pending&&i.text===text),'pending remained');
   if(failure){check(document.querySelector('.draft').textContent===text,'draft not restored');el.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true}));document.getSelection().selectAllChildren(el);el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'deleteContentBackward'}));await wait(50);}
   else check(state.items.filter(i=>i.text==='server:'+text).length===1,'not reconciled uniquely');
  }
 }
 document.body.insertAdjacentHTML('beforeend','<pre id="ready">passed '+JSON.stringify(timings)+'</pre>');
}catch(e){document.body.insertAdjacentHTML('beforeend','<pre id="ready">'+e.stack+'</pre>');}
`,
		);
		server.setIndexFile(join(root, "index.html"));
		const { port } = await server.listen(0);
		const page = await browser.solveChallenge({
			url: `http://127.0.0.1:${port}/`,
			readySelector: "#ready",
			label: "Optimistic send",
			isSolved: (candidate) => candidate.text.includes('id="ready">'),
		});
		writeFileSync(join(root, "browser-result.html"), page.text);
		expect(page.text).toContain('id="ready">passed');
	} finally {
		await browser.shutdown();
		await server.close();
	}
}, 60000);
