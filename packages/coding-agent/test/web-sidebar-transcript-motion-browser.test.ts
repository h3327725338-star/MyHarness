import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"moves active chats to the top with a slide, switches at once and folds answer segments in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-motion-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const now = Date.now();
		const chat = (id: string, modified: number) => ({
			path: `C:/fixture/${id}.jsonl`,
			id,
			name: `Chat ${id}`,
			modified,
			firstMessage: id,
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
			server.route("GET", "/api/sessions/unbound", () => ({
				sessions: [chat("a", now - 1000), chat("b", now - 2000), chat("c", now - 3000)],
			}));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/transcript", () => ({ items: [] }));
			server.route("GET", "/api/slots", () => ({
				slots: [{ slot: "sb", sessionFile: "C:/fixture/b.jsonl", sessionId: "b", unbound: true, hasContent: true }],
			}));
			server.route("GET", "/api/state", () => ({
				items: [],
				session: { id: "b", file: "C:/fixture/b.jsonl" },
				app: {},
				flags: {},
				thinking: {},
				trust: { trusted: true },
				surface: { widgets: {}, statuses: {} },
				queue: { steering: [], followUp: [] },
				run: {},
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
			server.route("POST", "/api/seen", () => ({ ok: true }));
			server.route("POST", "/api/sessions/open", async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return { slot: "sb", created: true };
			});
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="side" style="width:280px;height:600px;display:flex;flex-direction:column"></div><div id="app" style="height:600px;display:flex;flex-direction:column"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {Transcript} from '/js/transcript.js';
import {Composer} from '/js/composer.js';
import {actions} from '/js/actions.js';
import {loadWorkspaces,set,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const order=()=>[...document.querySelectorAll('#side .chat-row')].map(r=>r.title).join(',');
try {
 document.documentElement.dataset.motion='on';
 setView({lang:'en',motion:'on',processDefault:'collapsed',expanded:{'<general>':true}});
 await loadWorkspaces(); render(h(Sidebar),document.getElementById('side')); await wait(400);
 if(order()!=='Chat a,Chat b,Chat c') throw Error('initial order '+order());
 // The chats that were there when the list appeared are shown at once, not grown in one by one.
 if([...document.querySelectorAll('#side .chat-slot .collapse')].some(c=>c.getBoundingClientRect().height<30)) throw Error('initial rows animated in');
 // A chat that starts running goes to the top at once and slides there; only it and the rows it passes move.
 set({slots:[{slot:'sc',sessionFile:'C:/fixture/c.jsonl',sessionId:'c',unbound:true,hasContent:true,active:true}]}); await wait(30);
 if(order()!=='Chat c,Chat a,Chat b') throw Error('running chat not first: '+order());
 const moving=document.querySelector('#side .chat-slot[data-path="C:/fixture/c.jsonl"]');
 if(!moving.getAnimations().length) throw Error('moved row did not slide');
 await wait(400);
 // It stays first after it finished, by its last activity; looking at another chat does not move that chat.
 set({slots:[{slot:'sc',sessionFile:'C:/fixture/c.jsonl',sessionId:'c',unbound:true,hasContent:true,active:false,lastActivityAt:Date.now()}]}); await wait(50);
 if(order()!=='Chat c,Chat a,Chat b') throw Error('finished chat dropped: '+order());
 // Insertions use just the grid expansion: no FLIP on the rows below and no node replacement.
 const oldA=document.querySelector('#side .chat-slot[data-path="C:/fixture/a.jsonl"]');
 const oldB=document.querySelector('#side .chat-slot[data-path="C:/fixture/b.jsonl"]');
 const scroller=document.querySelector('#side .sidebar-scroll');
 const scrollBefore=scroller.scrollTop;
 set({activeSlot:'sd',slots:[...state.slots,{slot:'sd',sessionFile:'C:/fixture/d.jsonl',sessionId:'d',unbound:true,hasContent:false}]});
 const heights=[];
 for(let i=0;i<24;i++) { await wait(16); heights.push(oldA.getBoundingClientRect().top); if(oldA.getAnimations().length || oldB.getAnimations().length) throw Error('insert stacked FLIP on collapse'); }
 if(document.querySelector('#side .chat-slot[data-path="C:/fixture/a.jsonl"]')!==oldA) throw Error('existing row remounted');
 if(scroller.scrollTop!==scrollBefore) throw Error('insert scrolled sidebar');
 if(heights.some((value,i)=>i && value<heights[i-1]-0.5)) throw Error('insert moved backwards');
 if(Math.abs(heights.at(-1)-heights[0]-34)>4) throw Error('insert displacement '+heights);
 // Removing a blank chat folds in place, without a second slide on its neighbours.
 set({activeSlot:'sc',slots:state.slots.filter(s=>s.slot!=='sd')}); await wait(30);
 if(oldA.getAnimations().length) throw Error('exit stacked FLIP');
 await wait(400);
 if(document.querySelector('#side .chat-slot[data-path="C:/fixture/d.jsonl"]')) throw Error('blank row did not leave');
 // Switching: the clicked row is marked at once and the switch is never held back by the slide.
 const row=[...document.querySelectorAll('#side .chat-row')].find(r=>r.title==='Chat b');
 row.click(); await wait(0);
 if(!row.classList.contains('current') || state.opening!=='C:/fixture/b.jsonl') throw Error('clicked row not marked at once');
 await wait(400);
 if(state.activeSlot!=='sb' || state.opening) throw Error('switch did not finish: '+state.activeSlot);
 // Answer segments: reasoning and tools fold into blocks between the texts, the block being written into is open.
 const live=(blocks,final)=>({kind:'assistant',id:'a'+blocks.length,liveId:'L'+blocks.length,ts:2,model:'m',blocks,stopReason:final?'stop':'toolUse',final});
 const first=[{type:'thinking',text:'**Plan** look around'},{type:'text',text:'I will list the folder.'},{type:'toolCall',id:'c1',name:'ls',args:{path:'.'}}];
 set({items:[{kind:'user',id:'u1',ts:1,text:'go',images:[]},live(first,true),{kind:'toolResult',ts:3,toolCallId:'c1',toolName:'ls',text:'x',images:[],isError:false},live([{type:'toolCall',id:'c2',name:'ls',args:{path:'..'}}],false)],snap:{active:true,cwd:'C:/t',flags:{},session:{id:'b',file:'C:/fixture/b.jsonl'},run:{startedAt:Date.now()}},toolRuns:{c2:{status:'running'}},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),document.getElementById('app')); await wait(400);
 const parts=()=>[...document.querySelector('.turn').children].slice(1).map(c=>c.classList.contains('summary')?(c.querySelector('.summary-head').getAttribute('aria-expanded')==='true'?'open':'closed'):'text').join(',');
 if(parts()!=='closed,text,open') throw Error('segments while running: '+parts());
 // The user opens the earlier block; the model then writes text: the running block folds, the opened one stays open.
 document.querySelector('.turn .summary-head').click(); await wait(300);
 set({items:[...state.items,{kind:'toolResult',ts:5,toolCallId:'c2',toolName:'ls',text:'y',images:[],isError:false},live([{type:'text',text:'Done.'}],false)],toolRuns:{c2:{status:'done'}}}); await wait(400);
 if(parts()!=='open,text,closed,text') throw Error('segments after text: '+parts());
 if(!document.querySelector('.turn').textContent.includes('Done.')) throw Error('answer missing');
 // Slash candidates animate up above the editor, including the expanded editor.
 render(null,document.getElementById('app'));
 set({items:[],snap:{cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id:'slash',file:'C:/fixture/slash.jsonl'},thinking:{},run:{},queue:{},app:{}},surface:{widgets:{},statuses:{}},queue:{steering:[],followUp:[]},dialogs:[],resources:{commands:[{name:'help',description:'Help'},{name:'new',description:'New chat'}],tools:[],skills:[],templates:[],extensions:[]},editorInsert:{text:'/',replace:true}});
 render(h(Composer),document.getElementById('app')); await wait(70);
 const menu=document.querySelector('.suggest');
 if(!menu) throw Error('slash menu missing');
 if(getComputedStyle(menu).animationName!=='suggest-open') throw Error('slash entrance missing');
 const editor=document.querySelector('.composer-input');
 if(menu.getBoundingClientRect().bottom>editor.getBoundingClientRect().top) throw Error('slash covers editor');
 const card=document.querySelector('.composer'); card.classList.add('expanded'); await wait(300);
 if(menu.getBoundingClientRect().bottom>editor.getBoundingClientRect().top) throw Error('expanded slash covers editor');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Sidebar and transcript motion",
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
