import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The right-hand panel belongs to the conversation on screen: every chat keeps its own tabs, its own active tab and its
 * own Changes scope, a chat that never opened a tab has an empty panel, and switching back restores that chat's panel
 * exactly as it was. Two chats showing the same website get two tabs (the id keys a native browser view in the
 * desktop host), so neither shows the other's page. This runs the shipped store/actions unchanged; only the API routes
 * are stubs.
 */
it.skipIf(!installed.length)(
	"keeps one workspace panel per conversation and restores it when the chat comes back",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-workspace-panel-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
			// Runs in the plain unit suite too: headless, never a window pulled to the front.
			unattended: true,
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {activateSlot,chatTucked,panelInstance,setView,state} from '/js/store.js';
import {actions} from '/js/actions.js';
import {ChangesPanel} from '/js/panel-changes.js';
import {BranchChip} from '/js/branch-menu.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(ok,message)=>{if(!ok)throw Error(message)};
const ids=()=>state.view.wsTabs.map(tab=>tab.id);
try{
 const realFetch=window.fetch.bind(window);
 // A desktop host that only records what the panel asks of the native browser views.
 const hostCalls=[];
 window.myHarnessDesktop={browser:async command=>{hostCalls.push(command.action);return {ok:true};}};
 const snap=slot=>({slot,mode:'coding',cwd:'C:/fixture',session:{id:slot,file:slot,persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},thinking:{levels:[]},trust:{},run:{},app:{},workspace:{name:'fixture',rootPath:'C:/fixture'}});
 window.fetch=async(url,init={})=>{
  const slot=init.headers?.['x-myharness-slot']||'';
  if(url==='/api/state')return new Response(JSON.stringify(snap(slot)));
  if(url.startsWith('/api/transcript'))return new Response(JSON.stringify({items:[]}));
  if(url==='/api/slots')return new Response(JSON.stringify({slots:[]}));
  if(url.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
  if(url.includes('unbound')||url.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
  if(url.startsWith('/api/git/status'))return new Response(JSON.stringify({isRepository:true,gitAvailable:true,branch:'main',head:{sha:'abcdef1234567',subject:'x'},preview:{total:2,lines:[],truncated:false}}));
  // Two scopes, two numbers: this chat owns one uncommitted file, the folder has two, and either answer carries how much
  // of the chat is still uncommitted.
  if(url.startsWith('/api/changes?scope=session'))return new Response(JSON.stringify({scope:'session',files:[{path:'one.ts',status:'modified',additions:1,deletions:0,binary:false}],total:1,uncommitted:3}));
  if(url.startsWith('/api/changes?scope=worktree'))return new Response(JSON.stringify({scope:'worktree',files:[],total:2,error:null,uncommitted:3}));
  if(url.startsWith('/api/changes/diff'))return new Response(JSON.stringify({summary:{path:'one.ts',status:'modified',additions:1,deletions:0,binary:false},patch:''}));
  if(url.startsWith('/api/changes'))return new Response(JSON.stringify({files:[],total:0,uncommitted:0}));
  if(url==='/api/resources')return new Response(JSON.stringify({commands:[]}));
  return new Response('{}');
 };

 // A chat that never opened a tab has an empty panel.
 await activateSlot('a');
 must(state.snap?.session?.id==='a','the first chat did not load');
 must(state.view.wsTabs.length===0,'a chat started with tabs: '+JSON.stringify(ids()));
 must(state.view.panelOpen===false,'a chat started with the panel open');
 must(state.view.changesScope==='session','the default changes scope is not the conversation');

 actions.openWorkspace({type:'file',path:'one.ts'});
 actions.openWorkspace({type:'changes'});
 actions.openWorkspace({type:'browser',url:'https://example.com/'});
 setView({changesScope:'worktree'});
 const inA=ids();
 must(inA.length===3,'opening three tabs in A failed: '+JSON.stringify(inA));
 must(inA.includes('file:one.ts')&&inA.includes('changes'),'the panel tabs of A are wrong: '+JSON.stringify(inA));
 must(state.view.panelOpen===true,'the panel did not open');
 must(state.view.wsActive===inA[2],'the last opened tab is not active: '+state.view.wsActive);
 await wait(30);

 // Another chat: nothing of A follows it, and the changes scope starts from that chat's own value.
 const hidesBefore=hostCalls.filter(action=>action==='hide').length;
 await activateSlot('b');
 must(hostCalls.filter(action=>action==='hide').length>hidesBefore,'the browser view of A was left on screen for B');
 must(state.view.wsTabs.length===0,'B inherited the tabs of A: '+JSON.stringify(ids()));
 must(state.view.panelOpen===false,'B started with the panel open');
 must(state.view.changesScope==='session','the changes scope followed the other chat');

 actions.openWorkspace({type:'browser',url:'https://example.com/'});
 actions.openWorkspace({type:'file',path:'two.ts'});
 const inB=ids();
 must(inB.length===2,'opening tabs in B failed: '+JSON.stringify(inB));
 const browserA=inA.find(id=>id.startsWith('browser:'));
 const browserB=inB.find(id=>id.startsWith('browser:'));
 must(browserA!==browserB,'two chats share one browser tab id: '+browserA);
 await wait(30);

 // Coming back restores exactly what was open there, including the scope that chat was reading.
 await activateSlot('a');
 must(JSON.stringify(ids())===JSON.stringify(inA),'A tabs were not restored: '+JSON.stringify(ids()));
 must(state.view.panelOpen===true,'A panel did not come back open');
 must(state.view.wsActive===inA[2],'A active tab was not restored: '+state.view.wsActive);
 must(state.view.changesScope==='worktree','A changes scope was not restored: '+state.view.changesScope);

 // Collaboration mode and the widths are the chat's own too. A is widened and maximized; B, whose panel is open as well,
 // keeps its plain layout, its width and the sidebar, and A comes back as it was, also after a chat with nothing open.
 const layout=()=>JSON.stringify({open:state.view.panelOpen,max:state.view.wsMax,hidden:state.view.wsChatHidden,panelW:state.view.panelW,chatW:state.view.chatW,sidebar:state.view.sidebarOpen});
 must(state.view.sidebarOpen===true&&state.view.panelW===560,'setup: the sidebar or the default width is not the fixture\\'s: '+layout());
 const shownA=panelInstance();
 setView({panelW:640});
 actions.toggleWorkspaceMax(true);
 await wait(400);
 setView({chatW:500});
 must(state.view.wsMax===true&&state.view.sidebarOpen===false,'collaboration mode did not start: '+layout());
 // A tucks its conversation away at the right edge; that is A's layout too.
 actions.showConversation(false);
 must(state.view.wsChatHidden===true&&chatTucked(),'hiding the conversation did not tuck it away: '+layout());
 await activateSlot('b');
 must(panelInstance()!==shownA,'B shows the panel components of A');
 must(state.view.panelOpen===true&&state.view.wsMax===false,'B took the collaboration mode of A: '+layout());
 must(state.view.panelW===560&&state.view.sidebarOpen===true,'B took the width of A, or its sidebar stayed hidden: '+layout());
 setView({panelW:700});
 actions.toggleWorkspaceMax(true);
 await wait(400);
 must(state.view.wsChatHidden===false&&!chatTucked(),'B started with the conversation tucked away like A: '+layout());
 // B was never maximized: its chat column starts from the width dragged last (in A) and is B's own from now on.
 must(state.view.chatW===500,'B did not start from the last dragged chat column width: '+layout());
 setView({chatW:380});
 actions.toggleWorkspaceMax(false);
 await wait(400);
 await activateSlot('c');
 must(state.view.wsMax===false,'a chat with nothing open is shown maximized: '+layout());
 // A chat without a panel of its own starts from the width dragged last.
 must(state.view.panelW===700&&state.view.chatW===380,'a chat without a panel did not start from the last widths: '+layout());
 await activateSlot('a');
 must(state.view.wsMax===true&&state.view.panelW===640&&state.view.chatW===500&&state.view.sidebarOpen===false&&state.view.wsChatHidden===true,'A did not come back as it was: '+layout());
 actions.toggleWorkspaceMax(false);
 await wait(400);
 must(state.view.wsMax===false&&state.view.sidebarOpen===true&&state.view.wsChatHidden===false,'leaving collaboration mode did not give the sidebar and the conversation back: '+layout());
 await activateSlot('c');
 await activateSlot('a');
 must(state.view.wsMax===false,'collaboration mode came back after the user left it');

 await activateSlot('b');
 must(JSON.stringify(ids())===JSON.stringify(inB),'B tabs were not restored: '+JSON.stringify(ids()));
 must(state.view.wsActive==='file:two.ts','B active tab was not restored: '+state.view.wsActive);
 must(state.view.changesScope==='session','B changes scope was not restored: '+state.view.changesScope);
 must(state.view.wsMax===false&&state.view.panelW===700&&state.view.chatW===380,'B lost its own layout: '+layout());

 // Maximized in A and saved: the preferences keep each chat's widths and the sidebar of the plain layout, never
 // collaboration mode, which lasts as long as the page.
 await activateSlot('a');
 actions.toggleWorkspaceMax(true);
 await wait(400);
 const saved=JSON.parse(localStorage.getItem('myharness.web.prefs')||'{}');
 must(saved.wsPanels&&saved.wsPanels.a&&saved.wsPanels.b,'the per-conversation panels were not saved: '+JSON.stringify(saved.wsPanels));
 must(JSON.stringify(saved.wsPanels.a.wsTabs.map(tab=>tab.id))===JSON.stringify(inA),'the saved panel of A is wrong');
 must(saved.wsPanels.a.panelW===640&&saved.wsPanels.a.chatW===500&&saved.wsPanels.b.panelW===700,'the widths of each chat were not saved: '+JSON.stringify(saved.wsPanels));
 must(saved.panelW===700&&saved.chatW===380,'the widths a new chat starts with were not saved: '+JSON.stringify({panelW:saved.panelW,chatW:saved.chatW}));
 must(!('wsMax' in saved.wsPanels.a)&&!('wsSidebar' in saved.wsPanels.a)&&!('wsChatHidden' in saved.wsPanels.a),'collaboration mode was saved: '+JSON.stringify(saved.wsPanels.a));
 must(saved.sidebarOpen===true,'the sidebar hidden by collaboration mode was saved as hidden');
 must(saved.wsTabs===undefined,'the old global tab list is still written');
 actions.toggleWorkspaceMax(false);
 await wait(400);

 // The uncommitted count sits on the scope button that owns it: the conversation's own number on This chat,
 // the folder's whole number on Working tree. There is no separate explanatory row.
 setView({chatMode:'coding'});
 setView({changesScope:'session'});
 render(h(ChangesPanel,{}),document.getElementById('app'));
 const scopeButton=(label)=>[...document.querySelectorAll('.panel-toolbar .segmented button')].find(b=>b.textContent.trim().startsWith(label));
 // The counts render a moment after the panel; a fixed short wait read them too early on a slow runner.
 for(const end=Date.now()+4000;Date.now()<end&&!(scopeButton('This chat')?.textContent.trim()==='This chat 3'&&scopeButton('Working tree')?.textContent.trim()==='Working tree 2');)await wait(20);
 must(!!scopeButton('This chat'),'the Changes panel lost its conversation scope');
 must(scopeButton('This chat')?.textContent.trim()==='This chat 3','the conversation scope does not carry how much of this chat is uncommitted: '+scopeButton('This chat')?.textContent);
 must(scopeButton('Working tree')?.textContent.trim()==='Working tree 2','the worktree scope does not carry the uncommitted count: '+scopeButton('Working tree')?.textContent);
 must(!document.querySelector('.changes-basis'),'the Changes panel still shows an explanatory row');
 const gitBadges=[...document.querySelectorAll('.gitbar .badge')].map(node=>node.textContent.trim());
 must(!gitBadges.some(text=>text.includes('uncommitted')),'the Git bar still repeats the uncommitted count: '+JSON.stringify(gitBadges));

 // A general chat has no folder Git: the bar is not rendered there at all, and neither scope button carries a number.
 setView({chatMode:'general'});
 render(h(ChangesPanel,{}),document.getElementById('app'));
 await wait(80);
 must(scopeButton('This chat')?.textContent.trim()==='This chat','a general chat still shows the conversation uncommitted count: '+scopeButton('This chat')?.textContent);
 must(scopeButton('Working tree')?.textContent.trim()==='Working tree','a general chat still shows the folder uncommitted count: '+scopeButton('Working tree')?.textContent);
 must(!document.querySelector('.gitbar'),'a general chat still shows the folder Git bar');

 // The composer's branch chip keeps the branch but drops the folder's uncommitted count in a general chat.
 const chipStatus={gitAvailable:true,isRepository:true,branch:'main',head:{sha:'abcdef1',subject:'x'},preview:{total:2}};
 render(h(BranchChip,{gitStatus:chipStatus}),document.getElementById('app'));
 await wait(50);
 must(!document.querySelector('.branch-chip .badge'),'a general chat still shows the uncommitted count in the branch chip');
 setView({chatMode:'coding'});
 render(h(BranchChip,{gitStatus:chipStatus}),document.getElementById('app'));
 await wait(50);
 must(!!document.querySelector('.branch-chip .badge'),'a coding chat lost the uncommitted count in the branch chip');

 await realFetch('/api/test/result',{method:'POST',headers:{'content-type':'application/json','x-myharness-web':'1'},body:JSON.stringify({inA,inB})});
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack)+'</p>');}
`,
			);
			server.route("POST", "/api/test/result", () => ({ ok: true }));
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Workspace panel per conversation",
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
