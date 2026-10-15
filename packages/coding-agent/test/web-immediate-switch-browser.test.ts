import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"selects targets before delayed reads, blocks wrong-chat sends, keeps failures retryable and last click wins",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "immediate-switch-"));
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
import {Transcript} from '/js/transcript.js';
import {Composer} from '/js/composer.js';
import {actions} from '/js/actions.js';
import {activateSlot,state,set,setView,switchChatMode,canSendToActive,retrySwitch} from '/js/store.js';
import {interactionTimings} from '/js/interaction-timing.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const calls=[]; let fail=true;
const realFetch=window.fetch.bind(window);
window.addEventListener('error',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+event.message+'</p>')});
window.addEventListener('unhandledrejection',event=>{document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(event.reason?.stack||event.reason)+'</p>')});
window.fetch=async(url,init={})=>{
 const slot=init.headers?.['x-myharness-slot']||'';
 calls.push({url,slot});
 if(url==='/api/sessions/open'){
  const path=JSON.parse(init.body).path;
  await wait(path.includes('slow')?350:120);
  if(path.includes('bad')&&fail)return new Response(JSON.stringify({error:'read failed'}),{status:500});
  return new Response(JSON.stringify({slot:path}));
 }
 if(url==='/api/modes/open'){await wait(160);return new Response(JSON.stringify({slot:JSON.parse(init.body).mode,state:{drafts:{}}}));}
 if(url==='/api/state'){
  await wait(100);
  return new Response(JSON.stringify({slot,mode:slot==='general'?'general':'coding',cwd:'C:/fixture',session:{id:slot,file:slot,persisted:true,name:slot},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 }
 if(url.startsWith('/api/transcript')){await wait(150);return new Response(JSON.stringify({items:[{kind:'user',id:slot+'-u',ts:1,text:'message '+slot,images:[]}]}));}
 if(url==='/api/slots')return new Response(JSON.stringify({slots:[]}));
 if(url.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(url.includes('unbound')||url.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(url==='/api/resources')return new Response(JSON.stringify({commands:[],tools:[],skills:[],templates:[],extensions:[]}));
 return new Response('{}');
};
try{
 setView({lang:'en',motion:'off'});
 set({connected:true});
 await activateSlot('initial');
 render(h('div',{},h(Transcript,{}),h(Composer,{})),document.getElementById('app'));
 await wait(50);
 const start=performance.now();
 const opening=actions.openSession('slow');
 must(state.opening==='slow'&&state.snap.session.file==='slow','target not selected synchronously');
 must(performance.now()-start<100,'selection exceeded 100ms');
 must(!canSendToActive(),'pending target allowed sends');
 const before=calls.length;
 await actions.send('must not send');
 must(!calls.slice(before).some(c=>c.url==='/api/prompt'),'wrong-chat prompt');
 await wait(40);
 must(document.querySelector('.switch-placeholder'),'no immediate placeholder');
 must(!document.querySelector('.transcript-inner').textContent.includes('message initial'),'old transcript shown');
 const editor=document.querySelector('.composer-input');
 editor.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'draft for slow'}));
 await wait(30);
 must(editor.textContent.includes('draft for slow'),'typing during load lost');
 const newer=actions.openSession('fast');
 await newer;await opening;await wait(50);
 must(state.snap.session.file==='fast'&&!state.switching,'stale slow open replaced latest');
 must(canSendToActive(),'ready target stayed locked');
 must(!document.querySelector('.composer-input').textContent.includes('draft for slow'),'draft leaked to fast chat');
 await actions.openSession('slow');await wait(40);
 must(document.querySelector('.composer-input').textContent.includes('draft for slow'),'pending draft did not follow its target');
 await actions.openSession('fast');await wait(30);
 await actions.send('safe');
 must(calls.filter(c=>c.url==='/api/prompt').at(-1).slot==='fast','send did not explicitly target ready chat');
 await actions.openSession('bad');await wait(30);
 must(state.opening==='bad'&&state.switching.error,'failed selection rolled back');
 must(document.querySelector('.switch-placeholder button'),'no retry button');
 fail=false;await retrySwitch();must(state.snap.session.file==='bad'&&!state.switching,'retry failed');
 const mode=switchChatMode('general');
 must(state.view.chatMode==='general'&&state.view.modeIntent==='general','mode shell did not follow button');
 must(!canSendToActive(),'mode preparation allowed sending');
 await mode;await wait(30);
 must(state.snap.mode==='general'&&!state.switching,'mode failed to finish');
 // Exercise native View Transition callbacks as well as reduced-motion fallback.
 setView({motion:'system'});
 if(document.startViewTransition){
  const back=switchChatMode('coding');
  must(!canSendToActive(),'animated switch did not lock sends');
  await back;await wait(650);
  must(state.snap.mode==='coding'&&!state.switching,'animated mode switch failed');
 }
 // A large uncached transcript must paint a bounded tail immediately, never Welcome.
 const large=[];
 for(let i=0;i<500;i++)large.push({kind:'user',id:'large-'+i,ts:i,text:'large message '+i,images:[]});
 set({items:large,toolRuns:{}});
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 must(!document.querySelector('.welcome'),'large transcript flashed Welcome');
 await wait(200);
 must(document.querySelector('.transcript-inner').textContent.includes('large message 499'),'large tail missing');
 must(interactionTimings().some(s=>s.visibleMs<100&&s.contentMs>100),'missing separate visual/content measurements');
 const timingResponse=await realFetch('/api/test/timing',{method:'POST',headers:{'content-type':'application/json','x-myharness-web':'1'},body:JSON.stringify(interactionTimings())});
 must(timingResponse.ok,'failed to record timing samples');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack)+'</p>');}
`,
			);
			server.route("POST", "/api/test/timing", ({ body }) => {
				const output = process.env.MYHARNESS_ARTIFACTS_DIR;
				if (output) {
					mkdirSync(join(output, "tests"), { recursive: true });
					writeFileSync(join(output, "tests", "interaction-timing.json"), JSON.stringify(body, null, 2));
				}
				return { ok: true };
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Immediate session selection",
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
