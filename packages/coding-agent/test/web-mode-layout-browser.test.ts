import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// Coding and General each keep their own layout: collaboration mode entered in General does not follow a mode switch
// into Coding (not even for a moment while the switch reveals it), the Coding chat comes back with its own panel and
// the sidebar from before, and returning to General maximizes its workspace again with its sidebar as it was there.
const installed = detectInstalledBrowsers();

const page = `
import {actions} from '/js/actions.js';
import {activateSlot,loadSlots,panelSessionId,set,setView,state,subscribe,switchChatMode} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
window.addEventListener('error',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+event.message+'</p>')});
window.addEventListener('unhandledrejection',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(event.reason?.stack||event.reason)+'</p>')});
// C: a Coding chat with a file open; G: a General chat; C2: another Coding chat that is not loaded yet.
const sessions={C:'c-1',G:'g-1',C2:'c2-1'};
const modes={C:'coding',G:'general',C2:'coding'};
const info=(slot)=>({slot,mode:modes[slot],sessionId:sessions[slot],sessionFile:sessions[slot],cwd:'C:/fixture',name:null,firstMessage:'x',hasContent:true,active:false,waiting:false,completion:false,unbound:true,copy:false});
let codingTarget='C';
window.fetch=async(url,init={})=>{
 const u=String(url); const slot=init.headers?.['x-myharness-slot']||'';
 if(u==='/api/state')return new Response(JSON.stringify({slot,mode:modes[slot],cwd:'C:/fixture',session:{id:sessions[slot],file:sessions[slot],persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 if(u==='/api/modes/open'){
  const target=JSON.parse(init.body||'{}').mode==='general'?'G':codingTarget;
  return new Response(JSON.stringify({slot:target,state:{lastSessionFile:sessions[target]}}));
 }
 if(u.startsWith('/api/transcript'))return new Response(JSON.stringify({items:[]}));
 if(u==='/api/slots')return new Response(JSON.stringify({slots:Object.keys(sessions).map(info)}));
 if(u.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(u.includes('unbound')||u.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(u==='/api/resources')return new Response(JSON.stringify({commands:[],tools:[],skills:[],templates:[],extensions:[]}));
 return new Response('{}');
};
const show=()=>JSON.stringify({slot:state.activeSlot,mode:state.view.chatMode,key:panelSessionId(),open:state.view.panelOpen,tabs:state.view.wsTabs.map(t=>t.id),max:state.view.wsMax,sidebar:state.view.sidebarOpen});
// Every state the page renders: a Coding chat must never be drawn in General's collaboration layout.
const leaks=[];
subscribe(()=>{if(state.view.wsMax&&(state.view.chatMode==='coding'||String(panelSessionId()).startsWith('c')))leaks.push(show());});
const settle=()=>wait(900);
try{
 setView({lang:'en',motion:'on',chatMode:'coding',sidebarOpen:true});
 set({connected:true});
 must(typeof document.startViewTransition==='function'&&document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');
 await loadSlots();
 await activateSlot('C');
 actions.openWorkspace({type:'file',path:'C:/fixture/a.txt'});
 await activateSlot('G');
 await settle();
 actions.openWorkspace({type:'file',path:'C:/fixture/b.txt'});
 actions.toggleWorkspaceMax(true);
 await wait(400);
 must(state.view.chatMode==='general'&&state.view.wsMax===true&&state.view.sidebarOpen===false,'setup: General is not in collaboration mode: '+show());
 set({modeState:{coding:{lastSessionFile:'c-1'},general:{lastSessionFile:'g-1'}}});

 // (1) To Coding (its chat is loaded): plain layout, its own open panel, the sidebar from before collaboration mode.
 await switchChatMode('coding');
 await settle();
 must(state.activeSlot==='C'&&state.view.chatMode==='coding','(1) C is not on screen: '+show());
 must(state.view.wsMax===false,'(1) Coding took General\\'s collaboration mode: '+show());
 must(state.view.panelOpen===true&&state.view.wsTabs.some(t=>t.id==='file:C:/fixture/a.txt'),'(1) C lost its own panel: '+show());
 must(state.view.sidebarOpen===true,'(1) the sidebar from before collaboration mode did not come back: '+show());

 // (2) Back to General: maximized again, with its sidebar hidden as it was there.
 await switchChatMode('general');
 await settle();
 must(state.activeSlot==='G'&&state.view.wsMax===true,'(2) General lost its collaboration mode: '+show());
 must(state.view.sidebarOpen===false&&state.view.wsTabs.some(t=>t.id==='file:C:/fixture/b.txt'),'(2) General did not come back as it was: '+show());

 // (3) To a Coding chat that still has to load (and has nothing open): plain layout from the first frame.
 codingTarget='C2';
 set({modeState:{coding:{lastSessionFile:'c2-1'},general:{lastSessionFile:'g-1'}}});
 await switchChatMode('coding');
 await settle();
 must(state.activeSlot==='C2'&&state.view.chatMode==='coding','(3) C2 is not on screen: '+show());
 must(state.view.wsMax===false&&state.view.panelOpen===false,'(3) C2 is not in the plain layout: '+show());
 must(state.view.sidebarOpen===true,'(3) the sidebar did not come back: '+show());
 await switchChatMode('general');
 await settle();
 must(state.activeSlot==='G'&&state.view.wsMax===true&&state.view.sidebarOpen===false,'(3) General lost its collaboration mode after a loading switch: '+show());

 // (4) The sidebar opened while in General's collaboration mode stays open in Coding and is still open back in General.
 setView({sidebarOpen:true});
 await switchChatMode('coding');
 await settle();
 must(state.view.wsMax===false&&state.view.sidebarOpen===true,'(4) Coding did not keep the opened sidebar: '+show());
 await switchChatMode('general');
 await settle();
 must(state.view.wsMax===true&&state.view.sidebarOpen===true,'(4) General did not come back with its sidebar shown: '+show());

 // (5) Leaving collaboration mode in General ends it there: it does not come back after a trip to Coding.
 actions.toggleWorkspaceMax(false);
 await wait(400);
 await switchChatMode('coding');
 await settle();
 await switchChatMode('general');
 await settle();
 must(state.view.wsMax===false,'(5) collaboration mode came back after the user left it: '+show());
 must(leaks.length===0,'a Coding chat was drawn maximized: '+leaks.slice(0,3).join(' | '));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"each chat mode keeps its own collaboration layout across a mode switch",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "mode-layout-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			// The .mode-switch button gives the reveal a place to start from, as on the real page.
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><button class="mode-switch">mode</button><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(join(root, "test.js"), page);
			const { port } = await server.listen(0);
			const result = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/test/index.html`,
				readySelector: "#ready",
				label: "Mode layout",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(result.text.match(/id="ready">([^<]*)/)?.[1]).toBe("passed");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
