import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"reuses cached turns when switching back: zero buildTurns, chunked mount still protects the first paint",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-turns-cache-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			const user = (p: string, i: number) => ({
				kind: "user",
				id: `u-${p}-${i}`,
				ts: 1000 + i,
				text: `question ${p} ${i} with enough words to make the transcript tall`,
				images: [],
			});
			const answer = (p: string, i: number) => ({
				kind: "assistant",
				id: `a-${p}-${i}`,
				ts: 1000 + i,
				model: "m",
				blocks: [{ type: "text", text: `answer ${p} ${i}` }],
				stopReason: "stop",
				final: `answer ${p} ${i}`,
			});
			// Eighty turns per slot: the visible window is 60, so a first mount must arrive in chunks; the turns
			// probe separately proves a switch-back to a visited slot builds nothing at all.
			const seed = (p: string) => {
				const items: unknown[] = [];
				for (let i = 0; i < 80; i += 1) items.push(user(p, i), answer(p, i));
				return items;
			};
			const itemSets: Record<string, unknown[]> = { sa: seed("a"), sb: seed("b") };
			server.route("GET", "/api/transcript", (ctx) => {
				const slot = String(ctx.req.headers["x-myharness-slot"] || "");
				return { items: itemSets[slot] ?? [] };
			});
			server.route("GET", "/api/state", (ctx) => {
				const slot = String(ctx.req.headers["x-myharness-slot"] || "");
				const id = slot === "sb" ? "b" : "a";
				return {
					cwd: "C:/t",
					active: false,
					flags: {},
					thinking: {},
					run: {},
					queue: { steering: [], followUp: [] },
					dialogs: [],
					surface: { statuses: {}, widgets: {} },
					trust: { trusted: true },
					session: { id, file: `C:/fixture/${id}.jsonl` },
					app: {},
				};
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
const turns=()=>document.querySelectorAll('.transcript-inner > section.turn').length;
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(50);}return cond();};
// Count the .turn nodes each DOM commit mounts: switching in (cached or not) arrives in chunks, while the
// buildTurns probe separately proves a cached switch-back does no building at all. This is the mount probe.
const sampleAdds=()=>{const batches=[];const mo=new MutationObserver((records)=>{let n=0;for(const r of records)for(const node of r.addedNodes)if(node.nodeType===1&&node.classList&&node.classList.contains('turn'))n++;if(n)batches.push(n);});mo.observe(document.getElementById('app'),{childList:true,subtree:true});return {batches,stop:()=>mo.disconnect()};};
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(100);
 const base=turnsProbe.builds;
 // Cold open A: one build, mounting arrives in chunks (first commit at most 20 of the 60-window).
 const tapA=sampleAdds();
 await activateSlot('sa');
 if(!await waitFor(()=>turns()===60,5000)){tapA.stop();throw Error('A never reached 60 turns');}
 await wait(300);
 tapA.stop();
 if(turnsProbe.builds-base!==1) throw Error('cold A built '+turnsProbe.builds+' minus '+base);
 if(tapA.batches.length<2) throw Error('cold A did not chunk: '+tapA.batches.join(','));
 if(tapA.batches[0]>20) throw Error('cold A first commit mounted '+tapA.batches[0]+', want <= 20');
 if(tapA.batches.reduce((a,b)=>a+b,0)!==60) throw Error('cold A mounted '+tapA.batches.reduce((a,b)=>a+b,0)+' turns, want 60');
 // Cold open B (its own build, its own chunks).
 const bAfterA=turnsProbe.builds;
 const tapB=sampleAdds();
 await activateSlot('sb');
 if(!await waitFor(()=>turns()===60,5000)){tapB.stop();throw Error('B never reached 60 turns');}
 await wait(300);
 tapB.stop();
 if(turnsProbe.builds-bAfterA!==1) throw Error('cold B did not build once');
 if(tapB.batches.length<2) throw Error('cold B did not chunk: '+tapB.batches.join(','));
 // Switch back to A (nobody wrote to its bag since): the cached turns must be served without building,
 // and the W173 chunked arrival must stay (measured: a full-window first commit triples first paint).
 const bAfterB=turnsProbe.builds;
 const tapBack=sampleAdds();
 await activateSlot('sa');
 if(!await waitFor(()=>turns()===60,5000)){tapBack.stop();throw Error('revisit A never reached 60 turns');}
 await wait(300);
 tapBack.stop();
 if(turnsProbe.builds!==bAfterB) throw Error('revisit A rebuilt turns: +'+(turnsProbe.builds-bAfterB));
 if(tapBack.batches[0]>20) throw Error('revisit A first commit mounted '+tapBack.batches[0]+', want <= 20 (chunking stays)');
 if(tapBack.batches.reduce((a,b)=>a+b,0)!==60) throw Error('revisit A mounted '+tapBack.batches.reduce((a,b)=>a+b,0)+' turns, want 60');
 // Unrelated store writes must not rebuild either (items/toolRuns references stay unchanged).
 const beforeQuiet=turnsProbe.builds;
 set({dialogs:[]});
 await wait(300);
 if(turnsProbe.builds!==beforeQuiet) throw Error('unrelated emit rebuilt turns: +'+(turnsProbe.builds-beforeQuiet));
 // A streamed message replaces the items array: the reference change must force exactly one rebuild.
 const beforeStream=turnsProbe.builds;
 set({items:[...state.items,{kind:'user',id:'u-live',ts:9000,text:'a streamed question at the end',images:[]},{kind:'assistant',id:'a-live',ts:9001,model:'m',blocks:[{type:'text',text:'a streamed answer'}],stopReason:'stop',final:'a streamed answer'}]});
 await wait(300);
 if(turnsProbe.builds-beforeStream!==1) throw Error('streamed items rebuilt '+((turnsProbe.builds-beforeStream)||'0')+' times, want 1');
 if(!document.querySelectorAll('.transcript-inner > section.turn')[59].textContent.includes('a streamed answer')) throw Error('streamed turn not shown');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Transcript turns cache",
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
