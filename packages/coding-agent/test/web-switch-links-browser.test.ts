import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows a chat at once after a reconnect, keeps the composer neutral while opening, routes web links and draws images by address",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "switch-links-"));
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
window.addEventListener('error',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+event.message+'</p>')});
window.addEventListener('unhandledrejection',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(event.reason?.stack||event.reason)+'</p>')});
// The desktop host's bridge, before any module reads it: a built-in browser and the system browser.
const external=[];
window.myHarnessDesktop={browser:async()=>({}),external:async(url)=>{external.push(url);}};
const {h,render}=await import('/vendor/preact.js');
const {Transcript}=await import('/js/transcript.js');
const {Composer}=await import('/js/composer.js');
const {actions}=await import('/js/actions.js');
const {activateSlot,refreshAll,state,set,setView,canSendToActive}=await import('/js/store.js');
const {installLinkRouting}=await import('/js/link-target.js');
const {runWorkspaceCommand}=await import('/js/workspace-host.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
const must=(x,m)=>{if(!x)throw Error(m)};
const calls=[];
let reads=0;
window.fetch=async(url,init={})=>{
 const slot=init.headers?.['x-myharness-slot']||'';
 calls.push({url,slot});
 if(url==='/api/sessions/open'){await wait(400);return new Response(JSON.stringify({slot:JSON.parse(init.body).path}));}
 if(url==='/api/state'){
  await wait(slot==='slow'?400:60);
  return new Response(JSON.stringify({slot,mode:'coding',cwd:'C:/fixture',session:{id:slot,file:slot,persisted:true,name:slot},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',name:'Model M',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 }
 if(url.startsWith('/api/transcript')){
  reads++;
  await wait(60);
  const items=[{kind:'user',id:slot+'-u',ts:1,text:'message '+slot+' read '+reads,images:slot==='a'?[{mimeType:'image/png',data:'',src:'/api/transcript/image?entry='+slot+'-u&index=0'}]:[]}];
  return new Response(JSON.stringify({items}));
 }
 if(url==='/api/slots')return new Response(JSON.stringify({slots:[]}));
 if(url.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(url.includes('unbound')||url.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(url==='/api/resources')return new Response(JSON.stringify({commands:[],tools:[],skills:[],templates:[],extensions:[]}));
 return new Response('{}');
};
try{
 setView({lang:'en',motion:'off'});
 set({connected:true});
 render(h('div',{},h(Transcript,{}),h(Composer,{})),document.getElementById('app'));
 await activateSlot('a');
 await activateSlot('b');
 await frames();
 // Large images are drawn from their address, which names the chat.
 await activateSlot('a');await frames();
 const img=document.querySelector('.user-images img');
 must(img&&img.getAttribute('src')==='/api/transcript/image?entry=a-u&index=0&slot=a','image not drawn by address: '+img?.getAttribute('src'));
 await activateSlot('b');await frames();

 // After the event stream comes back the other chat is read again, but switching to it shows what it held at once.
 await refreshAll();
 const before=calls.length;
 const switched=activateSlot('a');
 await frames();
 must(!document.querySelector('.switch-placeholder'),'stale chat showed the loading page');
 must(document.querySelector('.transcript-inner').textContent.includes('message a'),'stale chat content missing');
 must(canSendToActive(),'stale chat locked sending');
 await switched;await wait(250);
 must(calls.slice(before).some(c=>c.url==='/api/state'&&c.slot==='a'),'stale chat not read again');
 must(calls.slice(before).some(c=>c.url.startsWith('/api/transcript')&&c.slot==='a'),'stale chat transcript not read again');

 // A chat that is still opening has no model yet: no "add a provider" prompt and no "No model" chip meanwhile.
 const opening=actions.openSession('slow');
 await frames();
 must(document.querySelector('.switch-placeholder'),'cold chat did not show its loading page');
 const placeholder=document.querySelector('.composer-input')?.getAttribute('data-placeholder')||document.querySelector('.composer-input')?.getAttribute('aria-placeholder')||document.querySelector('.composer-zone').textContent;
 must(!/Add a provider/.test(placeholder)&&!/Add a provider/.test(document.querySelector('.composer-zone').innerHTML),'composer asked for a provider while opening');
 must(!document.querySelector('.composer-zone').textContent.includes('No model'),'model chip said No model while opening');
 await opening;await wait(50);
 must(document.querySelector('.composer-zone').textContent.includes('Model M'),'model chip did not follow the opened chat');

 // Web links: built-in browser by default, the system browser when chosen; app links and modified clicks untouched.
 installLinkRouting();
 const host=document.createElement('div');
 host.innerHTML='<a id="web" href="https://example.com/page" target="_blank">web</a><a id="app" href="/js/store.js">app</a><a id="signin" data-link-system href="https://example.com/signin" target="_blank">sign in</a>';
 document.body.appendChild(host);
 let prevented=null;
 window.addEventListener('click',(e)=>{prevented=e.defaultPrevented;e.preventDefault();});
 const click=(id,opts={})=>{prevented=null;document.getElementById(id).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,...opts}));return prevented;};
 must(click('web')===true,'web link not intercepted');
 must(state.view.wsTabs.some(t=>t.type==='browser'&&t.url==='https://example.com/page')&&state.view.panelOpen,'web link did not open a website tab');
 must(click('app')===false,'app link intercepted');
 must(click('signin')===true&&external.includes('https://example.com/signin'),'sign-in link left the system browser');
 must(!state.view.wsTabs.some(t=>t.url==='https://example.com/signin'),'sign-in link opened a tab');
 must(click('web',{ctrlKey:true})===false,'modified click intercepted');
 setView({linkTarget:'system'});
 const tabs=state.view.wsTabs.length;
 must(click('web')===false,'system choice still intercepted');
 must(state.view.wsTabs.length===tabs,'system choice opened a tab');

 // A link clicked inside an HTML preview (sent by the desktop host) follows the same choice.
 await runWorkspaceCommand({action:'open',tab:{type:'browser',url:'https://example.org/preview'},link:true});
 must(external.includes('https://example.org/preview'),'preview link did not go to the system browser');
 must(!state.view.wsTabs.some(t=>t.url==='https://example.org/preview'),'preview link opened a tab under the system choice');
 setView({linkTarget:'builtin'});
 await runWorkspaceCommand({action:'open',tab:{type:'browser',url:'https://example.org/preview'},link:true});
 must(state.view.wsTabs.some(t=>t.url==='https://example.org/preview'),'preview link did not open a tab under the built-in choice');
 // The Agent's own workspace commands never go to the system browser.
 setView({linkTarget:'system'});
 await runWorkspaceCommand({action:'open',tab:{type:'browser',url:'https://example.net/agent'}});
 must(state.view.wsTabs.some(t=>t.url==='https://example.net/agent'),'agent tab was redirected');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack)+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Switch and link routing",
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
