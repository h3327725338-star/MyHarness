import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
// The first page of a long chat can come back shorter than TRANSCRIPT_FIRST_PAGE (the server aligns the window
// forward to a user message) while `hasMore` still says older items exist. Those chats must keep rebuilding their
// turns when new messages arrive; the old rule only rebuilt past a fixed item count and left them frozen.
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"a paged first screen with fewer items than one page still shows a new message and its answer",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-paged-tail-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			// 254 items, exactly the shape a server-aligned page has: it starts on a user message, holds a whole number
			// of turns, and older items stay server-side (`hasMore`).
			const all: unknown[] = [];
			for (let turn = 1; turn <= 64; turn += 1) {
				all.push({ kind: "user", id: `u-${turn}`, ts: 1000 + turn * 10, text: `question ${turn}`, images: [] });
				all.push({
					kind: "assistant",
					id: `a-${turn}`,
					ts: 1001 + turn * 10,
					model: "m",
					blocks: [{ type: "text", text: `answer ${turn}` }],
					stopReason: "stop",
					final: `answer ${turn}`,
				});
				all.push({
					kind: "toolResult",
					id: `t-${turn}`,
					ts: 1002 + turn * 10,
					toolCallId: `call-${turn}`,
					toolName: "bash",
					text: `ok ${turn}`,
				});
				all.push({
					kind: "assistant",
					id: `a2-${turn}`,
					ts: 1003 + turn * 10,
					model: "m",
					blocks: [{ type: "text", text: `wrapped up ${turn}` }],
					stopReason: "stop",
				});
			}
			const items = all.slice(0, 254);
			server.route("GET", "/api/transcript", () => ({ items, hasMore: true, nextCursor: "cursor-1" }));
			server.route("GET", "/api/state", () => ({
				cwd: "C:/t",
				active: false,
				flags: {},
				thinking: {},
				run: {},
				queue: { steering: [], followUp: [] },
				dialogs: [],
				surface: { statuses: {}, widgets: {} },
				trust: { trusted: true },
				session: { id: "paged", file: "C:/fixture/paged.jsonl" },
				app: {},
			}));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				contextFiles: [],
				tools: [],
				skills: [],
				templates: [],
				extensions: [],
			}));
			server.route("GET", "/api/git/status", () => ({}));
			server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/api/context", () => ({}));
			server.route("GET", "/api/changes", () => ({ files: [], total: 0 }));
			server.route("GET", "/api/settings", () => ({}));
			server.route("POST", "/api/modes/state", () => ({}));
			server.route("POST", "/api/seen", () => ({ ok: true }));
			server.route("POST", "/api/prefs", () => ({ ok: true }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app" style="height:600px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {activateSlot, set, setView, state} from '/js/store.js';
import {turnsProbe} from '/js/turns.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(50);}return cond();};
const turns=()=>document.querySelectorAll('.transcript-inner > section.turn').length;
const text=()=>document.querySelector('.transcript-inner')?.textContent||'';
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(100);
 await activateSlot('spaged');
 if(!await waitFor(()=>turns()>0,15000)) throw Error('no turns mounted: '+turns());
 await wait(1200);
 const buildsAfterBoot=turnsProbe.builds;
 const last=state.items[state.items.length-1];
 const withUser=state.items.slice();
 withUser.push({kind:'user',id:'new-u',ts:(last.ts||0)+1000,text:'LATE-QUESTION',images:[]});
 set({items:withUser});
 await wait(300);
 const withAnswer=state.items.slice();
 withAnswer.push({kind:'assistant',id:'new-a',ts:(last.ts||0)+1001,model:'m',blocks:[{type:'text',text:'LATE-ANSWER'}],stopReason:'stop',final:'LATE-ANSWER'});
 set({items:withAnswer});
 if(!await waitFor(()=>text().includes('LATE-ANSWER'),6000)) throw Error('the answer never reached the screen; items='+state.items.length+' builds='+turnsProbe.builds);
 if(!text().includes('LATE-QUESTION')) throw Error('the question never reached the screen');
 const buildsForAppend=turnsProbe.builds-buildsAfterBoot;
 // One rebuild per data change at most, and never two projections at once: a runaway rebuild loop would blow past this.
 if(buildsForAppend>3) throw Error('appending two items rebuilt '+buildsForAppend+' times');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed builds='+buildsForAppend+'</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "paged transcript tail",
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
