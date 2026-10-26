import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps the blank new chat only where the new chat would go, closes a page over it, sends one request for a double click and the panel follows a replaced session",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "newchat-follow-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {SourcesPageHost} from '/js/sources-page.js';
import {actions} from '/js/actions.js';
import {activateSlot,loadSlots,panelSessionId,refreshSlot,state,set,setView} from '/js/store.js';
import {runWorkspaceCommand} from '/js/workspace-host.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const calls=[];
// The session each slot holds; 'blank' is replaced in place later (a deleted chat's slot getting a fresh chat).
const sessions={blank:'blank-1',chat:'chat-1',fresh:'fresh-1',moved:'moved-1',gone:'gone-1',home:'home-1',general:'general-1'};
// MyHarness's default working directory: where the service puts (and reuses) a new chat without a workspace.
const DEFAULT_DIR='C:/agent/default-workspace';
const info=(slot,extra={})=>({slot,mode:'coding',sessionId:sessions[slot],sessionFile:sessions[slot],cwd:DEFAULT_DIR,name:null,firstMessage:'',hasContent:false,active:false,waiting:false,completion:false,unbound:true,atDefaultDir:true,copy:false,...extra});
const slots={
 blank:info('blank'),
 chat:info('chat',{firstMessage:'hello',hasContent:true}),
 fresh:info('fresh'),
 // Blank, unbound because its workspace was removed, and still running in that workspace's folder.
 moved:info('moved',{cwd:'C:/proj/W',atDefaultDir:false}),
 // Blank, in a workspace whose folder was deleted.
 gone:info('gone',{cwd:'C:/proj/gone',unbound:false,atDefaultDir:false}),
 // Blank, in a workspace folder that is there.
 home:info('home',{cwd:'C:/proj/A',unbound:false,atDefaultDir:false}),
 general:info('general',{mode:'general'}),
};
window.addEventListener('error',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+event.message+'</p>')});
window.addEventListener('unhandledrejection',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(event.reason?.stack||event.reason)+'</p>')});
window.fetch=async(url,init={})=>{
 const slot=init.headers?.['x-myharness-slot']||'';
 calls.push({url,slot});
 if(url==='/api/sessions/new'){await wait(200);return new Response(JSON.stringify({slot:'fresh',created:true}));}
 if(url==='/api/state')return new Response(JSON.stringify({slot,mode:slots[slot]?.mode??'coding',cwd:slots[slot]?.cwd??DEFAULT_DIR,cwdMissing:slot==='gone',session:{id:sessions[slot],file:sessions[slot],persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 if(url.startsWith('/api/transcript'))return new Response(JSON.stringify({items:slot==='chat'?[{kind:'user',id:'u1',ts:1,text:'hello',images:[]}]:[]}));
 if(url==='/api/slots')return new Response(JSON.stringify({slots:Object.values(slots)}));
 if(url.startsWith('/api/workspaces/settings'))return new Response(JSON.stringify({workspace:{name:'W'},sources:[]}));
 if(url.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(url.includes('unbound')||url.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(url==='/api/resources')return new Response(JSON.stringify({commands:[],tools:[],skills:[],templates:[],extensions:[]}));
 return new Response('{}');
};
const posts=()=>calls.filter(c=>c.url==='/api/sessions/new').length;
try{
 setView({lang:'en',motion:'off',chatMode:'coding'});
 set({connected:true});
 await loadSlots();
 await activateSlot('blank');
 render(h('div',{},h(Composer,{}),h(SourcesPageHost,{})),document.getElementById('app'));
 await wait(50);
 must(panelSessionId()==='blank-1','the panel does not belong to the chat on screen');

 // ① The chat on screen is a blank new chat of the same mode and place (unbound, in the default directory): New chat
 // and /new keep it.
 for(const run of [()=>actions.newChat(),()=>actions.newSession()]){
  document.activeElement?.blur?.();
  const result=await run();
  must(result?.slot==='blank'&&result.created===false,'New chat did not keep the blank chat: '+JSON.stringify(result));
  must(!state.switching&&state.activeSlot==='blank','New chat switched away from the blank chat');
  await wait(20);
  must(document.activeElement?.classList.contains('composer-input'),'the composer was not focused');
 }
 must(posts()===0,'New chat on a blank chat still asked the service');
 // A typed draft is not content: the chat is still the same new chat.
 const input=document.querySelector('.composer-input');
 input.focus();
 document.execCommand('insertText',false,'draft words');
 await wait(50);
 must((await actions.newChat())?.created===false,'a draft made New chat open another chat');
 await wait(20);
 const kept=document.querySelector('.composer-input');
 must((kept.value??kept.textContent).includes('draft words'),'New chat dropped the draft');
 // Another place (a workspace folder) is a real new chat there.
 const other=actions.newSession('C:/elsewhere');
 must(state.switching,'a new chat in another folder was kept');
 await other;
 must(posts()===1,'a new chat in another folder sent '+posts()+' requests');

 // ② From a chat with messages, a double click is one request and one new chat.
 await activateSlot('chat');
 await wait(50);
 const before=posts();
 const first=actions.newChat();
 await wait(30);
 const second=await actions.newChat();
 must(second?.created===false,'the second click of a double click started another chat');
 await first;
 must(posts()===before+1,'a double click sent '+(posts()-before)+' requests');
 must(state.activeSlot==='fresh','the new chat is not on screen');

 // ③ A blank chat that is not where the new chat would go still asks the service, which starts the chat there: an
 // unbound chat left in a removed workspace's folder (New chat and /new go to the default directory), and /new from a
 // workspace chat whose folder is gone.
 for(const [slot,run] of [['moved',()=>actions.newChat()],['moved',()=>actions.newSession()],['gone',()=>actions.newSession()]]){
  await activateSlot(slot);
  await wait(50);
  const sent=posts();
  const result=await run();
  must(posts()===sent+1,'New chat from the blank chat '+slot+' did not ask the service');
  must(result?.slot==='fresh'&&state.activeSlot==='fresh','New chat from '+slot+' did not show the new chat');
 }
 // A blank chat in a workspace folder that is there is kept for /new and for that workspace's own New chat.
 await activateSlot('home');
 await wait(50);
 const sentHome=posts();
 for(const run of [()=>actions.newSession(),()=>actions.newSession('C:/proj/A')])
  must((await run())?.created===false&&state.activeSlot==='home','New chat did not keep the blank workspace chat');
 must(posts()===sentHome,'New chat on a blank workspace chat still asked the service');

 // ④ Project sources covers the blank chat: New chat keeps the chat, closes the page as a switch does, and gives the
 // keys to the input; with Settings open the keys stay where they are.
 await activateSlot('general');
 await wait(50);
 must(state.view.chatMode==='general','the fixture did not show the General chat');
 const sentSources=posts();
 setView({sourcesPage:{id:'w1',name:'W',slot:state.activeSlot}});
 await wait(80);
 must(document.querySelector('.sources-page'),'the fixture did not open the Sources page');
 document.activeElement?.blur?.();
 const covered=await actions.newChat();
 must(covered?.slot==='general'&&covered.created===false,'New chat over the Sources page did not keep the blank chat: '+JSON.stringify(covered));
 await wait(50);
 must(!state.view.sourcesPage&&!document.querySelector('.sources-page'),'New chat left the Sources page over the chat');
 must(document.activeElement?.classList.contains('composer-input'),'the composer was not focused after the Sources page closed');
 document.activeElement?.blur?.();
 setView({settingsOpen:true});
 must((await actions.newChat())?.created===false,'New chat with Settings open did not keep the blank chat');
 await wait(50);
 must(!document.activeElement?.classList.contains('composer-input'),'New chat moved the keys to the input behind Settings');
 setView({settingsOpen:false});
 must(posts()===sentSources,'New chat on the blank General chat asked the service');

 // ⑤ The slot on screen gets another session in place: the panel and the Agent's tabs follow it at once.
 await activateSlot('blank');
 await wait(50);
 sessions.blank='blank-2';
 await refreshSlot('blank');
 must(state.snap.session.id==='blank-2','the fixture did not replace the session');
 must(panelSessionId()==='blank-2','the panel stayed with the replaced session: '+panelSessionId());
 const opened=await runWorkspaceCommand({action:'open',tab:{type:'file',path:'C:/fixture/notes.txt'},sessionId:'blank-2'});
 must(opened.onScreen===true,'the tab of the chat on screen went to a saved panel: '+JSON.stringify(opened));
 must(state.view.panelOpen&&state.view.wsTabs.some(t=>t.path==='C:/fixture/notes.txt'),'the tab is not in the panel on screen');
 // A chat that is not on screen still only changes its own saved panel.
 const away=await runWorkspaceCommand({action:'open',tab:{type:'file',path:'C:/fixture/other.txt'},sessionId:'chat-1'});
 must(away.onScreen===false,'a chat off screen claimed its tab is on screen');
 must(!state.view.wsTabs.some(t=>t.path==='C:/fixture/other.txt'),'an off-screen chat changed the panel on screen');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack)+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "New chat reuse and panel follow",
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
