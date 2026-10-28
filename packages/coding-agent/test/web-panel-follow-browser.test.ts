import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The right panel follows the chat on screen only when that chat's own slot changed session. After Restart service the
// restored panel stays (with its closed-tab history and collaboration layout); a snapshot of the chat being left while a
// mode switch reveals another chat, or of the chat a reversed reveal brought back, never takes the other chat's tabs; and
// a chat replaced in place (Edit and resend) hands its website tabs on while the original keeps copies with new ids, so
// no native view is shared by two chats.
const installed = detectInstalledBrowsers();

const restartPage = `
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(30);}return cond();};
window.addEventListener('error',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+event.message+'</p>')});
const tabs=[{id:'files',type:'files'},{id:'file:C:/fixture/a.txt',type:'file',path:'C:/fixture/a.txt'}];
// The saved preferences have no panel for this chat (a page that never switched chats saved none).
globalThis.__MYHARNESS_BOOT_PREFS__={prefs:{lang:'en',motion:'off',chatMode:'coding',sidebarOpen:true}};
sessionStorage.setItem('myharness-service-restart',JSON.stringify({sessionId:'chat-1',view:{panelOpen:true,panelTab:'files',wsTabs:tabs,wsActive:'file:C:/fixture/a.txt',wsClosed:[{id:'file:C:/fixture/b.txt',type:'file',path:'C:/fixture/b.txt'}],wsMax:true,wsMaxSidebar:true,sidebarOpen:false,lang:'en',motion:'off',chatMode:'coding'},drafts:[],savedAt:Date.now()}));
class FakeEvents{constructor(){this.readyState=1;setTimeout(()=>this.onopen?.(),10);}addEventListener(){}close(){}}
window.EventSource=FakeEvents;
window.fetch=async(url)=>{
 const u=String(url);
 if(u.startsWith('/api/boot'))return new Response(JSON.stringify({phase:'ready',instanceId:'i'}));
 if(u.startsWith('/api/state'))return new Response(JSON.stringify({slot:'s1',mode:'coding',cwd:'C:/fixture',session:{id:'chat-1',file:'chat-1',persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 if(u.startsWith('/api/modes/state'))return new Response(JSON.stringify({coding:{lastSessionFile:'chat-1'},general:{}}));
 if(u.startsWith('/api/transcript'))return new Response(JSON.stringify({items:[]}));
 if(u.startsWith('/api/slots'))return new Response(JSON.stringify({slots:[]}));
 if(u.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 return new Response('{}');
};
try{
 const store=await import('/js/store.js');
 store.boot();
 must(await waitFor(()=>store.state.activeSlot==='s1'&&store.state.snap?.session?.id==='chat-1',5000),'the page never showed the restored chat');
 await wait(300);
 const check=(when)=>{
  const v=store.state.view;
  const got=JSON.stringify({key:store.panelSessionId(),open:v.panelOpen,tabs:v.wsTabs.map(t=>t.id),active:v.wsActive,closed:v.wsClosed.map(t=>t.id),max:v.wsMax,sidebar:v.sidebarOpen});
  must(store.panelSessionId()==='chat-1','('+when+') the restored panel does not belong to the chat on screen: '+got);
  must(v.panelOpen===true,'('+when+') the restored panel was closed: '+got);
  must(v.wsTabs.length===2&&v.wsActive==='file:C:/fixture/a.txt','('+when+') the restored tabs are gone: '+got);
  must(v.wsClosed.length===1&&v.wsClosed[0].id==='file:C:/fixture/b.txt','('+when+') the closed-tab history is gone: '+got);
  must(v.wsMax===true&&v.sidebarOpen===false,'('+when+') the collaboration layout was not kept: '+got);
 };
 check('after the reload');
 // A later snapshot of the same chat (a checkpoint, a settings change) leaves it alone.
 await store.loadSnapshot('s1');
 check('after another snapshot');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

const switchPage = `
import {actions} from '/js/actions.js';
import {activateSlot,loadSlots,loadSnapshot,panelInstance,panelSessionId,refreshSlot,set,setView,state,storedPanel,switchChatMode} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
window.addEventListener('error',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+event.message+'</p>')});
window.addEventListener('unhandledrejection',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(event.reason?.stack||event.reason)+'</p>')});
// A: a Coding chat with no tabs; B: a General chat with one file tab; A0 (later): the original of A after a fork.
const sessions={A:'a-1',B:'b-1'};
const modes={A:'coding',B:'general'};
let gate=null;
const info=(slot)=>({slot,mode:modes[slot],sessionId:sessions[slot],sessionFile:sessions[slot],cwd:'C:/fixture',name:null,firstMessage:'x',hasContent:true,active:false,waiting:false,completion:false,unbound:true,copy:false});
window.fetch=async(url,init={})=>{
 const u=String(url); const slot=init.headers?.['x-myharness-slot']||'';
 if(u==='/api/state'){
  if(slot==='A'&&gate)await gate;
  return new Response(JSON.stringify({slot,mode:modes[slot],cwd:'C:/fixture',session:{id:sessions[slot],file:sessions[slot],persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 }
 if(u.startsWith('/api/transcript'))return new Response(JSON.stringify({items:[]}));
 if(u==='/api/slots')return new Response(JSON.stringify({slots:Object.keys(sessions).map(info)}));
 if(u.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(u.includes('unbound')||u.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(u==='/api/resources')return new Response(JSON.stringify({commands:[],tools:[],skills:[],templates:[],extensions:[]}));
 return new Response('{}');
};
const ids=(panel)=>panel.wsTabs.map(t=>t.id);
const show=(x)=>JSON.stringify(x);
try{
 setView({lang:'en',motion:'on',chatMode:'coding'});
 set({connected:true});
 must(typeof document.startViewTransition==='function'&&document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');
 await loadSlots();
 await activateSlot('A');
 await activateSlot('B');
 await wait(800);
 actions.openWorkspace({type:'file',path:'C:/fixture/b.txt'});
 await activateSlot('A');
 await wait(800);
 set({modeState:{coding:{lastSessionFile:'a-1'},general:{lastSessionFile:'b-1'}}});
 must(panelSessionId()==='a-1'&&state.view.wsTabs.length===0,'setup: A is not on screen with its empty panel');

 // (1) A snapshot of A lands while the switch to General reveals B: A must not take B's tab.
 let release; gate=new Promise(r=>release=r);
 const snapA=loadSnapshot('A');
 await wait(20);
 const toGeneral=switchChatMode('general');
 setTimeout(release,0);
 await snapA; await toGeneral; await wait(100);
 gate=null;
 must(state.activeSlot==='B'&&panelSessionId()==='b-1','(1) B is not on screen with its panel: '+show({active:state.activeSlot,key:panelSessionId()}));
 must(ids(storedPanel('a-1')).length===0,'(1) the chat being left took the revealed chat\\'s tabs: '+show(ids(storedPanel('a-1'))));
 must(ids(storedPanel('b-1')).includes('file:C:/fixture/b.txt'),'(1) B lost its tab');

 // (2) Back to Coding, reversed halfway: A is on screen again with its own panel, and its next snapshot changes nothing.
 await activateSlot('A');
 await wait(800);
 const toGeneral2=switchChatMode('general');
 await wait(120);
 await switchChatMode('coding');
 await toGeneral2;
 await wait(900);
 must(state.activeSlot==='A'&&state.view.chatMode==='coding','(2) the reversed reveal did not bring A back: '+show({active:state.activeSlot,mode:state.view.chatMode}));
 must(panelSessionId()==='a-1'&&state.view.wsTabs.length===0,'(2) A is back on screen with another chat\\'s panel: '+show({key:panelSessionId(),tabs:ids(state.view)}));
 await loadSnapshot('A');
 must(ids(storedPanel('a-1')).length===0,'(2) A\\'s snapshot after the reversed reveal took B\\'s tabs: '+show(ids(storedPanel('a-1'))));
 must(ids(storedPanel('b-1')).includes('file:C:/fixture/b.txt'),'(2) B lost its tab');

 // (3) A opens two websites and a file, closes one website, and is forked in place (Edit and resend): the new session
 // keeps the live tabs, the original keeps copies whose website tabs have new ids.
 const host=[];
 window.myHarnessDesktop={browser:async(command)=>{host.push(command);return {};}};
 const one=actions.openWorkspace({type:'browser',url:'https://example.com/one'});
 const two=actions.openWorkspace({type:'browser',url:'https://example.com/two'});
 actions.openWorkspace({type:'file',path:'C:/fixture/a.txt'});
 actions.closeWorkspaceTab(two);
 actions.activateWorkspaceTab(one);
 must(state.view.wsClosed.some(t=>t.id===two),'(3) setup: the closed website is not in the closed-tab history');
 const mounted=panelInstance();
 sessions.A='a-2';
 await refreshSlot('A');
 must(panelSessionId()==='a-2','(3) the panel stayed with the replaced session: '+panelSessionId());
 must(panelInstance()===mounted,'(3) the panel on screen was mounted again when the new session took it over');
 must(ids(state.view).includes(one)&&state.view.wsActive===one,'(3) the new session lost the live website tab: '+show(ids(state.view)));
 const original=storedPanel('a-1');
 const copy=original.wsTabs.find(t=>t.type==='browser');
 must(copy&&copy.url==='https://example.com/one'&&copy.id!==one,'(3) the original chat shares the website tab id: '+show(original.wsTabs));
 must(original.wsActive===copy.id,'(3) the original chat\\'s active tab does not follow the new id: '+show({active:original.wsActive,copy:copy.id}));
 must(original.wsTabs.some(t=>t.id==='file:C:/fixture/a.txt'),'(3) the original chat lost its file tab');
 const closedCopy=original.wsClosed.find(t=>t.type==='browser');
 must(closedCopy&&closedCopy.url==='https://example.com/two'&&closedCopy.id!==two,'(3) the original chat shares the closed website tab id: '+show(original.wsClosed));
 // The original opened again in another slot: closing its website tab closes its own view, not the fork's.
 sessions.A0='a-1'; modes.A0='coding';
 await loadSlots();
 await activateSlot('A0');
 await wait(50);
 must(panelSessionId()==='a-1'&&ids(state.view).includes(copy.id),'(3) the original does not show its copied tabs: '+show(ids(state.view)));
 actions.closeWorkspaceTab(copy.id);
 const closes=host.filter(c=>c.action==='close').map(c=>c.tabId);
 must(closes.includes(copy.id)&&!closes.includes(one),'(3) closing the original\\'s tab closed '+show(closes));
 await activateSlot('A');
 await wait(50);
 must(panelSessionId()==='a-2'&&ids(state.view).includes(one),'(3) the fork lost its website tab: '+show(ids(state.view)));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the panel follows only the chat whose own slot changed session",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "panel-follow-"));
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
			for (const [name, script] of [
				["restart", restartPage],
				["switch", switchPage],
			]) {
				writeFileSync(
					join(root, `${name}.html`),
					`<!doctype html><button class="mode-switch">mode</button><div id="app"></div><script type="module" src="/test/${name}.js"></script>`,
				);
				writeFileSync(join(root, `${name}.js`), script);
			}
			const { port } = await server.listen(0);
			for (const name of ["restart", "switch"]) {
				const page = await browser.solveChallenge({
					url: `http://127.0.0.1:${port}/test/${name}.html`,
					readySelector: "#ready",
					label: `Panel follow (${name})`,
					isSolved: (candidate) => candidate.text.includes('id="ready">'),
				});
				expect(page.text.match(/id="ready">([^<]*)/)?.[1], name).toBe("passed");
			}
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
