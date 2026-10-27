/**
 * W175: the frontend consumes the paged transcript (W172 server): a cold switch downloads only the
 * newest page (limit=120), and "Show earlier" fetches older pages from the server once memory runs out.
 * Each case drives the real store.js + transcript.js in a real browser against a stub server that speaks
 * the W172 paging dialect (limit / before / hasMore / nextCursor).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
const targeted = process.env.MYHARNESS_TARGETED_BROWSER_E2E === "1" && installed.length > 0;

const pad3 = (n: number) => String(n).padStart(3, "0");
// ~1.1KB per item: the full 500-item transcript exceeds 500KB while the 120-item first page stays below it.
const bigUser = (n: number) => ({
	kind: "user",
	id: `p-${2 * n}`,
	ts: 1000 + n,
	text: `QUESTION-${pad3(n)} ${"x".repeat(1000)}`,
	images: [],
});
const bigAssistant = (n: number) => ({
	kind: "assistant",
	id: `p-${2 * n + 1}`,
	ts: 1001 + n,
	blocks: [{ type: "text", text: `ANSWER-${pad3(n)} ${"y".repeat(1000)}` }],
	stopReason: "stop",
	provider: "p",
	model: "m",
	final: true,
});
const fullItems = Array.from({ length: 250 }, (_, n) => [bigUser(n), bigAssistant(n)]).flat();
const smallItems = Array.from({ length: 5 }, (_, n) => [
	{ kind: "user", id: `b-${2 * n}`, ts: 1, text: `B-QUESTION-00${n}`, images: [] },
	{
		kind: "assistant",
		id: `b-${2 * n + 1}`,
		ts: 2,
		blocks: [{ type: "text", text: `B-ANSWER-00${n}` }],
		stopReason: "stop",
		provider: "p",
		model: "m",
		final: true,
	},
]).flat();

interface TranscriptCall {
	url: string;
	slot: string | null;
	bytes: number;
}

function pageOf(items: { id: string; kind: string }[], limitRaw: string | null, before: string | null) {
	let end = items.length;
	if (before) {
		const idx = items.findIndex((entry) => entry.id === before);
		if (idx >= 0) end = idx;
	}
	let start = 0;
	if (limitRaw) {
		const n = Number.parseInt(limitRaw, 10);
		if (Number.isInteger(n) && end > n) start = end - n;
	}
	if (start > 0 && items[start]?.kind !== "user") start += 1;
	return { start, page: items.slice(start, end) };
}

function stateFor(slot: string, id: string) {
	return {
		slot,
		session: { id, file: `C:/fixture/${id}.jsonl`, persisted: false },
		mode: "coding",
		cwd: "C:/t",
		app: {},
		flags: {},
		thinking: {},
		trust: { trusted: true },
		surface: { widgets: {}, statuses: {} },
		queue: { steering: [], followUp: [] },
		dialogs: [],
		run: {},
		workspace: null,
	};
}

async function runInBrowser(
	label: string,
	testJs: string,
	routes: (server: WebHttpServer, calls: TranscriptCall[]) => void,
) {
	const calls: TranscriptCall[] = [];
	const root = mkdtempSync(join(tmpdir(), "myharness-paging-"));
	const server = new WebHttpServer();
	const browser = new LocalBrowser({
		kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
		rootDir: join(root, "browser"),
	});
	try {
		for (const dir of ["js", "vendor", "css"])
			server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
		server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
		server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
		server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
		server.route("GET", "/api/slots", () => ({ slots: [] }));
		server.route("GET", "/api/state", ({ req }) => {
			const slot = (req.headers["x-myharness-slot"] as string) || "slot-a";
			return slot === "slot-b" ? stateFor(slot, "b") : stateFor(slot, "a");
		});
		server.route("GET", "/api/resources", () => ({
			commands: [],
			contextFiles: [],
			tools: [],
			skills: [],
			templates: [],
			extensions: [],
		}));
		server.route("GET", "/api/git/status", () => ({}));
		server.route("GET", "/api/models", () => ({ models: [] }));
		routes(server, calls);
		server.mount({ prefix: "/test/", directory: root });
		writeFileSync(
			join(root, "index.html"),
			'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="app" style="height:600px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
		);
		writeFileSync(join(root, "test.js"), testJs);
		server.setIndexFile(join(root, "index.html"));
		const { port } = await server.listen(0);
		const page = await browser.solveChallenge({
			url: `http://127.0.0.1:${port}/`,
			readySelector: "#ready",
			label,
			isSolved: (candidate) => candidate.text.includes('id="ready">'),
		});
		expect(page.text).toContain('id="ready">passed');
		return calls;
	} finally {
		await browser.shutdown();
		await server.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
}

function pagingRoutes(server: WebHttpServer, calls: TranscriptCall[]) {
	server.route("GET", "/api/transcript", ({ url, req }) => {
		const slot = (req.headers["x-myharness-slot"] as string) ?? null;
		const items = slot === "slot-b" ? smallItems : fullItems;
		const limitRaw = url.searchParams.get("limit");
		const before = url.searchParams.get("before");
		const { start, page } = pageOf(items, limitRaw, before);
		const body =
			limitRaw || before
				? { items: page, hasMore: start > 0, nextCursor: start > 0 ? (page[0] as { id: string }).id : null }
				: { items: page };
		calls.push({ url: url.pathname + url.search, slot, bytes: JSON.stringify(body).length });
		return body;
	});
}

it.skipIf(!targeted)(
	"cold switch downloads only the newest page, then Show earlier reaches item 1 without gaps or dupes",
	async () => {
		const calls = await runInBrowser(
			"Transcript paging first page",
			`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {activateSlot,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const earlier=()=>document.querySelector('.transcript .earlier');
try {
 setView({lang:'en',motion:'on',processDefault:'collapsed'});
 await activateSlot('slot-a');
 if(state.items.length!==120) throw Error('first screen items '+state.items.length);
 if(state.transcriptHasMore!==true) throw Error('hasMore not set');
 if(state.transcriptCursor!=='p-380') throw Error('cursor '+state.transcriptCursor);
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(800);
 if(!document.querySelector('.transcript').textContent.includes('QUESTION-249')) throw Error('newest turn missing');
 let clicks=0;
 while(earlier() && clicks<20) { earlier().click(); clicks++; await wait(400); }
 if(earlier()) throw Error('earlier button still there after '+clicks+' clicks');
 for(let n=0;n<80 && (state.items.length!==500 || document.querySelectorAll('.transcript .turn').length!==250);n++) await wait(100);
 const ids=state.items.map(i=>i.id);
 if(ids.length!==500) throw Error('items '+ids.length);
 if(new Set(ids).size!==500) throw Error('duplicate items');
 for(let i=0;i<500;i++) if(ids[i]!=='p-'+i) throw Error('order gap at '+i+': '+ids[i]);
 if(!document.querySelector('.transcript').textContent.includes('QUESTION-000')) throw Error('first turn missing');
 if(document.querySelectorAll('.transcript .turn').length!==250) throw Error('turns '+document.querySelectorAll('.transcript .turn').length);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			pagingRoutes,
		);
		const first = calls.filter((call) => call.slot === "slot-a");
		expect(first[0]?.url).toBe("/api/transcript?images=ref&limit=120");
		expect(first[0]?.bytes).toBeLessThan(180_000);
		expect(JSON.stringify({ items: fullItems }).length).toBeGreaterThan(500_000);
	},
	120000,
);

it.skipIf(!targeted)(
	"an older page in flight never pollutes the chat switched to",
	async () => {
		const calls = await runInBrowser(
			"Transcript paging switch race",
			`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {activateSlot,fetchMoreTranscript,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 setView({lang:'en',motion:'on',processDefault:'collapsed'});
 await activateSlot('slot-a');
 const realFetch=globalThis.fetch;
 let held=null;
 globalThis.fetch=(url,init)=>String(url).includes('before=')?new Promise((resolve)=>{held=()=>resolve(realFetch(url,init));}):realFetch(url,init);
 void fetchMoreTranscript('slot-a');
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(300);
 if(state.transcriptFetching!==true) throw Error('older page not fetching');
 await activateSlot('slot-b');
 await wait(500);
 if(state.items.length!==10) throw Error('slot-b items '+state.items.length);
 if(!document.querySelector('.transcript').textContent.includes('B-QUESTION-004')) throw Error('slot-b content wrong');
 held(); held=null;
 await wait(500);
 if(state.items.length!==10) throw Error('slot-b polluted: '+state.items.length);
 globalThis.fetch=realFetch;
 await activateSlot('slot-a');
 await wait(500);
 const ids=state.items.map(i=>i.id);
 if(ids.length!==500) throw Error('slot-a items '+ids.length);
 if(new Set(ids).size!==500) throw Error('slot-a duplicates');
 for(let i=0;i<500;i++) if(ids[i]!=='p-'+i) throw Error('slot-a gap at '+i);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			pagingRoutes,
		);
		expect(calls.some((call) => call.url.includes("before="))).toBe(true);
	},
	120000,
);

it.skipIf(!targeted)(
	"streamed output during a fetch falls back to a full reload",
	async () => {
		const calls = await runInBrowser(
			"Transcript paging stream race",
			`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {activateSlot,fetchMoreTranscript,appendStreamedItem,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 setView({lang:'en',motion:'on',processDefault:'collapsed'});
 await activateSlot('slot-a');
 const realFetch=globalThis.fetch;
 let held=null;
 globalThis.fetch=(url,init)=>String(url).includes('before=')?new Promise((resolve)=>{held=()=>resolve(realFetch(url,init));}):realFetch(url,init);
 void fetchMoreTranscript('slot-a');
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(300);
 if(state.transcriptFetching!==true) throw Error('older page not fetching');
 appendStreamedItem({kind:'user',id:'w175-live',ts:99999,text:'LIVE QUESTION',images:[]});
 held(); held=null;
 globalThis.fetch=realFetch;
 await wait(800);
 const ids=state.items.map(i=>i.id);
 if(ids.length!==500) throw Error('items '+ids.length);
 if(new Set(ids).size!==500) throw Error('duplicates');
 for(let i=0;i<500;i++) if(ids[i]!=='p-'+i) throw Error('gap at '+i);
 if(state.transcriptHasMore!==false) throw Error('hasMore stuck');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			pagingRoutes,
		);
		expect(calls.some((call) => call.url === "/api/transcript?images=ref")).toBe(true);
	},
	120000,
);

it.skipIf(!targeted)(
	"an old server without paging falls back to the full transcript",
	async () => {
		const calls = await runInBrowser(
			"Transcript paging legacy server",
			`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {activateSlot,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const earlier=()=>document.querySelector('.transcript .earlier');
try {
 setView({lang:'en',motion:'on',processDefault:'collapsed'});
 await activateSlot('slot-a');
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(800);
 if(state.items.length!==500) throw Error('legacy items '+state.items.length);
 if(state.transcriptHasMore!==false) throw Error('legacy hasMore set');
 let clicks=0;
 while(earlier() && clicks<10) { earlier().click(); clicks++; await wait(300); }
 if(earlier()) throw Error('button stuck');
 if(!document.querySelector('.transcript').textContent.includes('QUESTION-000')) throw Error('first turn missing');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			(server, calls) => {
				server.route("GET", "/api/transcript", ({ url, req }) => {
					const body = { items: fullItems };
					calls.push({
						url: url.pathname + url.search,
						slot: (req.headers["x-myharness-slot"] as string) ?? null,
						bytes: JSON.stringify(body).length,
					});
					return body;
				});
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/transcript?images=ref&limit=120");
	},
	120000,
);
