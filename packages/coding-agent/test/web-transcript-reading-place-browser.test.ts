import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// Each chat keeps the reader's place: back to a chat left in the middle shows the same turn at the same place in the
// first frame (first commit still <= 20 turns), new messages there keep it and show the jump button, sending from further
// up keeps it too, a chat left at the bottom comes back at the bottom, a reopened slot of the same session finds the
// place, and a place whose turn is gone opens at the bottom. A task-end notification's landing wins over a remembered
// place. A remount of the Transcript (a language switch rebuilds the interface) stays where the reader is, and the
// notification of a chat that waits for an answer opens it at the bottom whatever place was remembered. A switch through
// a loading page (a mode switch) still comes back to the place, and a narrowing column keeps the text at the top.
const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps each chat's reading place across switches",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "reading-place-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			// Answers render as Markdown paragraphs, like the app, so a narrower column rewraps separate blocks.
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			const user = (p: string, i: number) => ({
				kind: "user",
				id: `u-${p}-${i}`,
				ts: 1000 + i,
				text: `question ${p} ${i}`,
				images: [],
			});
			const answer = (p: string, i: number) => {
				const text = Array.from(
					{ length: 12 },
					(_, k) =>
						`answer ${p} ${i} paragraph ${k} with enough words to wrap across the reading column of the transcript`,
				).join("\n\n");
				return {
					kind: "assistant",
					id: `a-${p}-${i}`,
					ts: 1000 + i,
					model: "m",
					blocks: [{ type: "text", text }],
					stopReason: "stop",
					final: text,
				};
			};
			const seed = (p: string, n: number) => {
				const items: unknown[] = [];
				for (let i = 0; i < n; i += 1) items.push(user(p, i), answer(p, i));
				return items;
			};
			const A = seed("a", 80);
			// sa2: the same chat reopened in a new slot; sa3: the same chat after its history was rewritten (other ids).
			const itemSets: Record<string, unknown[]> = { sa: A, sa2: A, sa3: seed("z", 30), sb: seed("b", 3) };
			const sessionOf: Record<string, string> = { sa: "a", sa2: "a", sa3: "a", sb: "b" };
			const slotOf = (ctx: { req: { headers: Record<string, unknown> } }) =>
				String(ctx.req.headers["x-myharness-slot"] || "");
			server.route("GET", "/api/transcript", (ctx) => ({ items: itemSets[slotOf(ctx)] ?? [] }));
			server.route("GET", "/api/state", (ctx) => {
				const id = sessionOf[slotOf(ctx)] ?? "a";
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
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app" style="height:600px;display:flex;flex-direction:column"></div><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {useLayoutEffect,useState} from '/vendor/preact-hooks.js';
import {Transcript} from '/js/transcript.js';
import {activateSlot, appendStreamedItem, inSlot, openChatAtBottom, openChatAtLastTurn, set, setView, state, subscribe} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(30);}return cond();};
const el=()=>document.querySelector('.transcript');
const turns=()=>document.querySelectorAll('.transcript-inner > section.turn').length;
const atBottom=()=>{const s=el();return s.scrollHeight-s.clientHeight-s.scrollTop<=2;};
const jumpShown=()=>!!document.querySelector('.jump-btn:not(.leaving)');
// The first turn still visible at the top of the view and how far its top is above it.
const anchor=()=>{const s=el();const top=s.getBoundingClientRect().top;for(const n of s.querySelectorAll('section.turn[data-turn-key]')){const r=n.getBoundingClientRect();if(r.bottom>top+1)return {key:n.dataset.turnKey,offset:Math.round(top-r.top)};}return null;};
const same=(a,b)=>!!a&&!!b&&a.key===b.key&&Math.abs(a.offset-b.offset)<=2;
const show=(a)=>JSON.stringify(a);
// Count the .turn nodes each DOM commit mounts (the chunked mount must stay: first commit <= 20).
const tap=()=>{const batches=[];const mo=new MutationObserver((records)=>{let n=0;for(const r of records)for(const node of r.addedNodes)if(node.nodeType===1&&node.classList?.contains('turn'))n++;if(n)batches.push(n);});mo.observe(document.getElementById('app'),{childList:true,subtree:true});return {batches,stop:()=>mo.disconnect()};};
// The reader scrolls by hand (the wheel marks it as the reader's own move, like the scroll test does).
// A language switch rebuilds the interface (main.js keys <App> by the language): the Transcript is a new instance.
function Chat(){return h(Transcript,{});}
function Root(){const [lang,setLang]=useState(state.view.lang);useLayoutEffect(()=>subscribe(()=>setLang(state.view.lang)),[]);return h(Chat,{key:lang});}
const scrollBy=async(dy)=>{const s=el();s.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:dy<0?-120:120}));s.scrollTop+=dy;s.dispatchEvent(new Event('scroll',{bubbles:true}));await frame();await frame();await wait(50);};
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 render(h(Root,{}),document.getElementById('app'));
 await wait(100);
 // (1) First open of a chat rests at the bottom.
 await activateSlot('sa');
 if(!await waitFor(()=>turns()===80&&atBottom(),6000)) throw Error('first open of A not at the bottom with 80 turns: '+turns());
 // (2) Read in the middle of A (outside the newest 20 turns), leave for B, come back: same turn at the same place.
 await scrollBy(-(el().scrollHeight*0.55));
 const left=anchor();
 if(!left||atBottom()) throw Error('could not scroll A to the middle');
 await activateSlot('sb');
 if(!await waitFor(()=>atBottom()&&turns()===3,6000)) throw Error('B not at the bottom');
 const t1=tap();
 await activateSlot('sa');
 await frame();
 const firstPaint=anchor();
 if(!same(firstPaint,left)) throw Error('back in A, first frame shows '+show(firstPaint)+', left at '+show(left));
 if(!await waitFor(()=>turns()===80,6000)) throw Error('A never mounted all 80 turns again');
 await wait(200); t1.stop();
 if(t1.batches[0]>20) throw Error('return mounted '+t1.batches[0]+' turns in its first commit, want <= 20');
 if(!same(anchor(),left)) throw Error('A moved while mounting: '+show(anchor())+' vs '+show(left));
 if(!jumpShown()) throw Error('jump button missing after the return');
 // (3) A chat left at the bottom comes back at the bottom.
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await activateSlot('sa'); await activateSlot('sb');
 if(!await waitFor(atBottom,3000)) throw Error('B left at the bottom did not come back at the bottom');
 // (4) New messages in A while B is shown: A keeps its place, the jump button says there is more below.
 inSlot('sa',()=>{set({items:[...state.items,{kind:'user',id:'u-new',ts:9000,text:'arrived while away',images:[]},{kind:'assistant',id:'a-new',ts:9001,model:'m',blocks:[{type:'text',text:'answer while away'}],stopReason:'stop',final:'answer while away'}]});});
 await activateSlot('sa');
 await frame();
 if(!same(anchor(),left)) throw Error('new messages pulled A away: '+show(anchor())+' vs '+show(left));
 await wait(300);
 if(!jumpShown()) throw Error('jump button missing with new messages below');
 // (5) Sending a message while reading further up does not move the view (the Agent works while the reader reads on);
 // the jump button leads down. Sent from the bottom, the view follows the sent message.
 const reading=anchor();
 appendStreamedItem({kind:'user',text:'my new question',images:[],ts:Date.now(),pending:true,clientMessageId:'c-1'},'sa');
 await frame(); await frame(); await wait(300);
 if(!same(anchor(),reading)) throw Error('sending moved the reader: '+show(anchor())+' vs '+show(reading));
 if(atBottom()) throw Error('sending from further up went to the bottom');
 if(!jumpShown()) throw Error('jump button missing after sending from further up');
 document.querySelector('.jump-btn').click();
 if(!await waitFor(atBottom,3000)) throw Error('the jump button did not lead to the bottom');
 await wait(200);
 appendStreamedItem({kind:'user',text:'asked from the bottom',images:[],ts:Date.now(),pending:true,clientMessageId:'c-2'},'sa');
 await frame(); await frame(); await wait(200);
 if(!atBottom()) throw Error('sending from the bottom did not show the sent message');
 // (6) The chat's slot was released and the chat reopened in a new slot (same session): the place still comes back.
 await scrollBy(-(el().scrollHeight*0.4));
 const left2=anchor();
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await activateSlot('sa2');
 if(!await waitFor(()=>same(anchor(),left2),4000)) throw Error('reopened A (new slot) shows '+show(anchor())+', left at '+show(left2));
 // (7) The turn the reader was at is gone (history rewritten): the chat opens at the bottom, as a first open.
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await activateSlot('sa3');
 if(!await waitFor(()=>atBottom()&&turns()>0,4000)) throw Error('a chat whose turn is gone did not open at the bottom');
 // (8) A notification landing wins over a remembered place: the last turn starts at the top and stays there.
 await activateSlot('sa2');
 await waitFor(()=>turns()===80,4000);
 await scrollBy(-(el().scrollHeight*0.5));
 if(atBottom()) throw Error('could not scroll the reopened A to the middle');
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await openChatAtLastTurn('sa2');
 const lastTop=()=>{const s2=el();const n=[...s2.querySelectorAll(':scope > .transcript-inner > section.turn[data-turn-key]')].pop();return Math.round(n.getBoundingClientRect().top-s2.getBoundingClientRect().top);};
 if(!await waitFor(()=>Math.abs(lastTop()-14)<=3,4000)) throw Error('landing did not put the last turn at the top: '+lastTop()+' anchor '+show(anchor()));
 await wait(600);
 if(Math.abs(lastTop()-14)>3) throw Error('the remembered place overrode the landing: '+lastTop());
 // (9) The Transcript remounts (language switch): read at the bottom, it stays at the bottom, not at the place A was left
 // at before the landing; read in the middle, the same turn comes back at the same place.
 await scrollBy(el().scrollHeight);
 if(!await waitFor(atBottom,2000)) throw Error('could not scroll A to the bottom');
 setView({lang:'zh-CN'});
 await wait(100);
 if(!await waitFor(()=>turns()===80&&atBottom(),4000)) throw Error('after a remount A read at the bottom shows '+show(anchor())+' (turns '+turns()+')');
 await wait(600);
 if(!atBottom()) throw Error('a remount pulled the reader away from the bottom to '+show(anchor()));
 await scrollBy(-(el().scrollHeight*0.3));
 const left3=anchor();
 if(!left3||atBottom()) throw Error('could not scroll A to the middle before the remount');
 setView({lang:'en'});
 await wait(100);
 if(!await waitFor(()=>turns()===80&&anchor()?.key===left3.key,4000)) throw Error('after a remount A shows '+show(anchor())+', the reader was at '+show(left3));
 await wait(300);
 const back3=anchor();
 if(back3?.key!==left3.key||Math.abs(back3.offset-left3.offset)>6) throw Error('after a remount A shows '+show(back3)+', the reader was at '+show(left3));
 // (10) A chat that waits for an answer: its notification opens it at the bottom, even though it was left in the middle.
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await openChatAtBottom('sa2');
 if(!await waitFor(()=>turns()===80&&atBottom(),4000)) throw Error('the waiting chat did not open at the bottom: '+show(anchor()));
 await wait(600);
 if(!atBottom()) throw Error('the remembered place pulled the waiting chat away from the bottom: '+show(anchor()));
 if(jumpShown()) throw Error('jump button shown after opening the waiting chat at the bottom');
 // Its remembered place is the bottom now: a plain return does not go back to the middle either.
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await activateSlot('sa2');
 await frame();
 if(!await waitFor(atBottom,3000)) throw Error('a plain return after the waiting chat opened at the bottom shows '+show(anchor()));
 // Already on screen and scrolled up: the click brings the reader down to the end.
 await waitFor(()=>turns()===80,4000); await wait(200);
 await scrollBy(-(el().scrollHeight*0.5));
 if(atBottom()) throw Error('could not scroll the waiting chat up');
 await openChatAtBottom('sa2');
 if(!await waitFor(atBottom,3000)) throw Error('the waiting chat on screen did not go to the bottom: '+show(anchor()));
 // (11) A switch that shows a loading page first (a mode switch, a chat not loaded yet) empties the page before the next
 // session arrives: the place is still remembered, and the chat comes back there instead of at the bottom.
 await scrollBy(-(el().scrollHeight*0.45));
 const left4=anchor();
 if(!left4||atBottom()) throw Error('could not scroll A to the middle before the loading switch');
 set({switching:{mode:'general',seq:-1,error:null}});
 await frame(); await frame();
 if(turns()!==0) throw Error('the loading page still shows '+turns()+' turns');
 await activateSlot('sb'); await waitFor(atBottom,3000);
 await activateSlot('sa2');
 if(!await waitFor(()=>same(anchor(),left4),4000)) throw Error('after a switch through a loading page A shows '+show(anchor())+', left at '+show(left4));
 // (12) The column narrows while the reader is further up (the panel sliding open beside a chat that comes back with
 // it): the paragraph at the top of the view stays there instead of the rewrapped text moving away.
 await waitFor(()=>turns()===80,4000); await wait(200);
 const app=document.getElementById('app');
 const topBlock=()=>{const top=el().getBoundingClientRect().top;for(const p of document.querySelectorAll('.transcript-inner p'))if(p.getBoundingClientRect().bottom>top+1)return p;return null;};
 const before=topBlock();
 const beforeTop=before.getBoundingClientRect().top-el().getBoundingClientRect().top;
 for(const w of [700,620,540,460,420]){app.style.width=w+'px';await frame();}
 await wait(300);
 const after=topBlock();
 const afterTop=before.getBoundingClientRect().top-el().getBoundingClientRect().top;
 if(after!==before||Math.abs(afterTop-beforeTop)>3) throw Error('narrowing the column moved the text: top block was "'+before.textContent.slice(0,40)+'" at '+Math.round(beforeTop)+', now "'+(after?.textContent||'').slice(0,40)+'" ('+Math.round(afterTop)+')');
 app.style.width='';
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error).replace(/</g,'&lt;')+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Transcript reading place",
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
