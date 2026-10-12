import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"virtualizes the sidebar workspace list: only the window around the visible area renders, filter/expand/keyboard/unread keep working",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-sidebar-virt-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/state", () => ({
				items: [],
				session: null,
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
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/sessions/open", async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return { slot: "s-opened", created: true };
			});
			server.route("GET", "/api/transcript", () => ({ items: [] }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="side" style="width:300px;height:600px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {set,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const names=()=>[...document.querySelectorAll('#side .ws .ws-row .name')].map(n=>n.textContent).filter(n=>n!=='Default');
const scroller=()=>document.querySelector('#side .sidebar-scroll');
const wsCount=()=>document.querySelectorAll('#side .ws').length;
try {
 setView({lang:'en',motion:'off',chatMode:'coding'});
 // 200 workspaces, each holding two saved chats; all collapsed.
 const list=Array.from({length:200},(_,i)=>({id:'w'+String(i).padStart(3,'0'),name:'proj-'+String(i).padStart(3,'0'),rootPath:'C:/t/proj-'+String(i).padStart(3,'0')}));
 const sessions={};
 for(let i=0;i<200;i++){
  const root=list[i].rootPath;
  sessions[root]=[0,1].map(k=>({id:'c'+i+'-'+k,path:root+'/chat-'+k+'.jsonl',name:'Chat '+i+'-'+k,firstMessage:(i>=150&&i<=152&&k===0)?'alpha keyword here':'',messageCount:3,modified:Date.now()-i*1000-k}));
 }
 set({workspaces:{list,sessions,unbound:[],archived:[],errors:{},loaded:true},slots:[],activeSlot:null});
 render(h(Sidebar),document.getElementById('side'));await wait(300);
 // 1) Only the window renders, far below the full 200.
 if(wsCount()>80) throw Error('too many .ws rendered: '+wsCount());
 if(wsCount()<10) throw Error('too few .ws rendered: '+wsCount());
 if(names()[0]!=='proj-000') throw Error('first group wrong: '+names()[0]);
 const fullHeight=scroller().scrollHeight;
 if(fullHeight<200*34) throw Error('total height not held up: '+fullHeight);
 // 2) Scroll to the middle: the visible groups are right and in order.
 scroller().scrollTop=(fullHeight-scroller().clientHeight)/2;await wait(250);
 const mid=names();
 if(mid.length>80) throw Error('too many .ws after middle scroll: '+mid.length);
 for(let i=1;i<mid.length;i++){if(mid[i]<=mid[i-1]) throw Error('middle order wrong at '+i+' ('+mid[i-1]+' -> '+mid[i]+') len='+mid.length+': '+mid.join(','));}
 const midFirst=Number(mid[0].slice(5));
 if(midFirst<60||midFirst>120) throw Error('middle window off: first='+mid[0]);
 // Scroll to the bottom: the tail renders in order, ending with the last workspace before Default.
 scroller().scrollTop=scroller().scrollHeight;await wait(250);
 const tail=names();
 if(tail[tail.length-1]!=='proj-199') throw Error('tail wrong: '+tail.slice(-3).join(','));
 if(![...document.querySelectorAll('#side .ws .ws-row .name')].some(n=>n.textContent==='Default')) throw Error('Default group missing at bottom');
 if(wsCount()>80) throw Error('too many .ws at bottom: '+wsCount());
 // 3) A filter matching 3 workspaces renders just those; clearing it restores the list sanely.
 const setFilter=(value)=>{
  const input=document.querySelector('#side .sidebar-search input');
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
 };
 setFilter('alpha keyword');await wait(400);
 const filtered=names();
 if(filtered.length!==3||filtered.join(',')!=='proj-150,proj-151,proj-152') throw Error('filter mismatch: '+filtered.join(','));
 if(wsCount()!==3) throw Error('filter renders extra groups: '+wsCount());
 setFilter('');await wait(400);
 if(wsCount()>80||wsCount()<10) throw Error('after clearing filter: '+wsCount());
 if(names()[0]!=='proj-000') throw Error('after clearing filter first='+names()[0]);
 // 4) Expanding one group shifts the groups below it by exactly its children height.
 scroller().scrollTop=0;await wait(250);
 const rows=()=>[...document.querySelectorAll('#side .ws .ws-row')];
 const secondBefore=rows()[1].getBoundingClientRect().top;
 rows()[0].click();await wait(300);
 const rowsAfter=()=>[...document.querySelectorAll('#side .ws .ws-row')];
 const secondAfter=rowsAfter()[1].getBoundingClientRect().top;
 if(Math.abs(secondAfter-secondBefore-2*34)>2) throw Error('expand shift wrong: '+(secondAfter-secondBefore));
 if(document.querySelectorAll('#side .ws')[0].querySelectorAll('.chat-row').length!==2) throw Error('expanded chats missing');
 rowsAfter()[0].click();await wait(300);
 const secondCollapsed=[...document.querySelectorAll('#side .ws .ws-row')][1].getBoundingClientRect().top;
 if(Math.abs(secondCollapsed-secondBefore)>2) throw Error('collapse did not restore: '+(secondCollapsed-secondBefore));
 // 5) Opening a chat does not scroll the sidebar (there is no auto-scroll today, keep it that way).
 scroller().scrollTop=0;await wait(250);
 const chatRow=document.querySelector('#side .ws .chat-row');
 const scrollBefore=scroller().scrollTop;
 chatRow.click();await wait(0);
 const openedPath=state.opening;
 if(!openedPath) throw Error('chat click did not mark opening');
 await wait(400);
 if(scroller().scrollTop!==scrollBefore) throw Error('sidebar scrolled on open');
 // 6) Keyboard: a focused row opens with Enter.
 scroller().scrollTop=0;await wait(250);
 set({opening:null});
 const row=[...document.querySelectorAll('#side .ws .ws-row')][2];
 row.focus();
 row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 await wait(150);
 if(row.getAttribute('aria-expanded')!=='true') throw Error('Enter did not expand the group');
 const chat=[...document.querySelectorAll('#side .ws')[2].querySelectorAll('.chat-row')][0];
 chat.focus();
 chat.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 await wait(0);
 if(!state.opening) throw Error('Enter did not open the chat');
 await wait(300);
 // 7) Running and unread indicators still show on windowed rows.
 set({opening:null,slots:[
  {slot:'a',sessionFile:'C:/t/proj-000/chat-0.jsonl',sessionId:'c0-0',cwd:'C:/t/proj-000',unbound:false,hasContent:true,active:true},
  {slot:'b',sessionFile:'C:/t/proj-001/chat-0.jsonl',sessionId:'c1-0',cwd:'C:/t/proj-001',unbound:false,hasContent:true,unread:true},
 ]});
 scroller().scrollTop=0;await wait(250);
 const firstWs=document.querySelectorAll('#side .ws')[0];
 if(!firstWs.querySelector('.chat-ind .ind-ring')) throw Error('running ring missing on windowed row');
 const unreadWs=document.querySelectorAll('#side .ws')[1];
 if(!unreadWs.querySelector('.ws-unread')) throw Error('workspace unread dot missing');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Sidebar virtualization",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			const verdict = /id="ready">([^<]*)</.exec(page.text)?.[1] ?? "no ready marker";
			expect(verdict).toBe("passed");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60000,
);
