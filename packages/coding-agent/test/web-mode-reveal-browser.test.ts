import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The mode reveal stays light: the turns out of view skip their contents while the old page is captured (and nothing on
// screen moves for it), older turns of the new chat wait for the reveal to end before they mount, the layout's own
// transitions are off inside it, and a switch that does not replace the chat gets its turns back as they were.
const installed = detectInstalledBrowsers();

const page = `
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView} from '/js/store.js';
import {revealMode} from '/js/mode-transition.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const must=(x,m)=>{if(!x)throw Error(m)};
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(30);}return cond();};
const user=(id,text)=>({kind:'user',id,ts:1,text,images:[]});
const live=(id,text)=>({kind:'assistant',id:'a'+id,liveId:'L'+id,ts:2,model:'m',blocks:[{type:'text',text}],stopReason:'stop',final:text});
const snapOf=(id)=>({cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id,file:'C:/fixture/'+id+'.jsonl'},thinking:{},run:{},queue:{},app:{}});
const chat=(prefix,id,count)=>{const items=[];for(let i=0;i<count;i++)items.push(user(prefix+i,prefix+' question '+i+' with enough words to make the transcript tall'),live(prefix+i,prefix+' answer '+i+'\\n\\nwith a second paragraph'));return {items,snap:snapOf(id),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]};};
const sections=()=>[...document.querySelectorAll('.transcript-inner > section.turn')];
const revealing=()=>document.documentElement.classList.contains('mode-revealing');
const geo=()=>{const el=document.querySelector('.transcript');const v=el.getBoundingClientRect();const vis=sections().find(n=>n.getBoundingClientRect().bottom>v.top);return {top:el.scrollTop,height:el.scrollHeight,first:vis?Math.round((vis.getBoundingClientRect().top-v.top)*100)/100:null};};
const original=document.startViewTransition?.bind(document);
let atCapture=null;
if(original)document.startViewTransition=(update)=>{atCapture={...geo(),skipped:sections().filter(n=>n.style.contentVisibility==='hidden').length,revealing:revealing()};return original(update);};
const app=document.querySelector('.app');
// The columns, the conversation's own margin (it changes when only one mode has the panel open) and the panel slot.
const durations=()=>[app,app.querySelector('.main'),app.querySelector('.panel-slot')].map(n=>getComputedStyle(n).transitionDuration);
const slow=()=>durations().every(d=>d!=='0s');
const still=()=>durations().every(d=>d==='0s');
try{
 setView({lang:'en',motion:'on',processDefault:'collapsed'});
 must(original&&document.visibilityState==='visible','no View Transition here: the mode reveal is not exercised');
 set(chat('u','s1',120));
 render(h(Transcript,{}),document.getElementById('chat'));
 must(await waitFor(()=>sections().length===120,5000),'the first chat never mounted all its turns: '+sections().length);
 must(slow(),'setup: the layout transitions are not there to turn off');
 // A reader in the middle of the chat.
 const el=document.querySelector('.transcript');
 el.scrollTop=Math.round(el.scrollHeight/2);
 await frame();await frame();
 const before=geo();

 // (1) A switch that replaces the chat.
 const reveal=revealMode(()=>set(chat('v','s2',120)),{from:'coding',to:'general'});
 const counts=[];
 let off=true;
 const t0=performance.now();
 // Counted once the new chat is on the page (the first frames still show the old one, before the capture).
 const fresh=()=>sections().some(n=>n.dataset.turnKey?.startsWith('t-v'));
 while(performance.now()-t0<2000){await frame();if(!revealing())break;off=off&&still();if(fresh())counts.push(sections().length);}
 await reveal;
 must(atCapture&&atCapture.revealing,'the layout transitions were not off at the capture: '+JSON.stringify(atCapture));
 must(atCapture.skipped>=100,'the turns out of view did not skip their contents at the capture: '+JSON.stringify(atCapture));
 must(atCapture.top===before.top&&atCapture.height===before.height&&atCapture.first===before.first,'the page moved when the turns out of view were skipped: '+JSON.stringify({before,atCapture}));
 must(counts.length>=10,'the reveal was not sampled while it ran: '+counts.length);
 must(off,'the layout transitions ran inside the reveal');
 must(Math.max(...counts)<=40,'older turns mounted during the reveal: '+counts.join(','));
 must(await waitFor(()=>!revealing()&&sections().length===120,4000),'the new chat did not finish mounting after the reveal: '+sections().length);
 must(slow(),'the layout transitions did not come back after the reveal');

 // (2) A switch that ends up not replacing the chat (superseded): its turns are drawn again as they were.
 el.scrollTop=Math.round(el.scrollHeight/3);
 await frame();await frame();
 const kept=geo();
 atCapture=null;
 await revealMode(()=>{},{from:'general',to:'coding'});
 must(atCapture&&atCapture.skipped>=100,'(2) the turns out of view did not skip their contents: '+JSON.stringify(atCapture));
 must(await waitFor(()=>!revealing(),3000),'(2) the reveal did not end');
 must(sections().every(n=>!n.style.contentVisibility&&!n.style.containIntrinsicBlockSize),'(2) turns of the chat that stayed are still skipped');
 const after=geo();
 must(after.top===kept.top&&after.height===kept.height&&after.first===kept.first,'(2) the chat that stayed moved: '+JSON.stringify({kept,after}));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the mode reveal skips turns out of view at the capture and mounts older turns after it",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "mode-reveal-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			// The .mode-switch button gives the reveal a place to start from; the hidden .app carries the layout's transitions.
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><button class="mode-switch">mode</button><div class="app" style="position:absolute;left:-9999px;width:10px;height:10px"><main class="main"></main><div class="panel-slot"></div></div><div id="chat" style="height:600px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(join(root, "test.js"), page);
			const { port } = await server.listen(0);
			const result = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/test/index.html`,
				readySelector: "#ready",
				label: "Mode reveal",
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
