import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"a long transcript keeps the full build while output streams: no preview swap back, no remount, no scroll jump",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-long-transcript-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			const user = (i: number) => ({
				kind: "user",
				id: `u-${i}`,
				ts: 1000 + i * 2,
				text: `question ${i} with enough words to make the transcript tall`,
				images: [],
			});
			const answer = (i: number) => ({
				kind: "assistant",
				id: `a-${i}`,
				ts: 1001 + i * 2,
				model: "m",
				blocks: [{ type: "text", text: `answer ${i}` }],
				stopReason: "stop",
				final: `answer ${i}`,
			});
			// 481 items: over the 400-item threshold, so the transcript is built by the async full projection and the
			// cold-load tail window is only the first paint. The change card sits inside the previous task (about eighty
			// items before the end): outside that tail window, inside the full transcript that replaces it. Those two views
			// of one scroll position are exactly what the two screenshots caught.
			const items: unknown[] = [];
			for (let i = 1; i <= 200; i += 1) items.push(user(i), answer(i));
			items.push({
				kind: "runChanges",
				id: "rc-marker",
				ts: 5000,
				runId: 1,
				files: [{ path: "src/app.ts", status: "modified", additions: 3, deletions: 1, binary: false }],
			});
			for (let i = 201; i <= 240; i += 1) items.push(user(i), answer(i));
			server.route("GET", "/api/transcript", () => ({ items, hasMore: false, nextCursor: null }));
			server.route("GET", "/api/state", () => ({
				cwd: "C:/t",
				active: true,
				flags: {},
				thinking: {},
				run: {},
				queue: { steering: [], followUp: [] },
				dialogs: [],
				surface: { statuses: {}, widgets: {} },
				trust: { trusted: true },
				session: { id: "long", file: "C:/fixture/long.jsonl" },
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
			server.route("POST", "/api/modes/state", () => ({}));
			server.route("POST", "/api/seen", () => ({ ok: true }));
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
const card=()=>document.querySelector('.transcript-inner .change-card');
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(100);
 const buildsBefore=turnsProbe.builds;
 await activateSlot('slong');
 // Cold load: the tail window paints first, the full projection replaces it, and all 240 turns mount in chunks.
 if(!await waitFor(()=>turns()===240,15000)) throw Error('the full transcript never mounted: '+turns()+' turns after '+(turnsProbe.builds-buildsBefore)+' builds');
 if(!await waitFor(()=>card()!=null,15000)) throw Error('the change card never arrived with the full transcript');
 if(turnsProbe.builds-buildsBefore<2) throw Error('the tail window and the full projection did not both build: '+(turnsProbe.builds-buildsBefore));
 const marker=card();
 const buildsAfterLoad=turnsProbe.builds;
 // Read two pages above the live tail. Then stream output into the newest turn: the same node must survive, nothing
 // may be remounted, and the reader's place must hold - the old preview/full alternation broke all three.
 const scroller=document.querySelector('.transcript');
 scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,bubbles:true}));
 scroller.scrollTop=Math.max(0,scroller.scrollHeight-scroller.clientHeight-600);
 await wait(120);
 const topBefore=scroller.scrollTop;
 if(topBefore<100) throw Error('the test could not scroll up: top '+topBefore);
 let removedTurns=0;
 const mo=new MutationObserver(records=>{for(const r of records)for(const node of r.removedNodes)if(node.nodeType===1&&node.classList&&node.classList.contains('turn'))removedTurns+=1;});
 mo.observe(document.getElementById('app'),{childList:true,subtree:true});
 for(let i=1;i<=8;i++){
   const next=state.items.slice();
   const last=next[next.length-1];
   next[next.length-1]={...last,blocks:[{type:'text',text:'streaming answer part '+i+' '+'x'.repeat(200)}]};
   set({items:next,toolRuns:{...state.toolRuns,['t-live-'+i]:{status:'running',partial:'partial output '+i}}});
   await wait(60);
 }
 await wait(900);
 mo.disconnect();
 const builds=turnsProbe.builds-buildsAfterLoad;
 if(builds<2) throw Error('the full projection stopped running while output streamed: '+builds+' builds');
 if(card()!==marker||!marker.isConnected) throw Error('the change card was replaced by a stream update');
 if(removedTurns>2) throw Error('stream updates remounted '+removedTurns+' turns');
 if(turns()!==240) throw Error('the shown transcript changed size: '+turns());
 if(!(document.querySelector('.transcript-inner').textContent||'').includes('streaming answer part 8')) throw Error('the newest streamed text never arrived');
 const moved=scroller.scrollTop-topBefore;
 if(Math.abs(moved)>40) throw Error('the reader\\'s place moved by '+Math.round(moved)+'px while output streamed');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Long transcript streaming",
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
