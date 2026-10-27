import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"mounts transcript turns in batches: at most 20 on the first frame, then batches of at most 20 that wait while keys come",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-chunk-"));
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
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app" style="height:600px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const user=(id,text)=>({kind:'user',id,ts:1,text,images:[]});
const live=(n,text)=>({kind:'assistant',id:'a'+n,liveId:'L'+n,ts:2,model:'m',blocks:[{type:'text',text}],stopReason:'stop',final:text});
const snapOf=(id)=>({cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id,file:'C:/fixture/'+id+'.jsonl'},thinking:{},run:{},queue:{},app:{}});
const seed=(count)=>{const items=[];for(let i=0;i<count;i++)items.push(user('u'+i,'seed question '+i+' with enough words to make the transcript tall'),live(i,'seed answer '+i));return items;};
const turns=()=>document.querySelectorAll('.transcript-inner > section.turn').length;
const frame=()=>new Promise((resolve)=>requestAnimationFrame(()=>resolve()));
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(50);}return cond();};
// Sample the mounted turn count on every DOM change: the first sample is what the first frame shows,
// no matter how effects and animation frames interleave on mount vs update.
const sampleMounts=()=>{const samples=[];const mo=new MutationObserver(()=>{const n=turns();if(!samples.length||samples[samples.length-1]!==n)samples.push(n);});mo.observe(document.getElementById('app'),{childList:true,subtree:true});return {samples,stop:()=>mo.disconnect()};};
// Every later batch is at most 20 turns (it is sized by what batches cost, see transcript.js nextChunk).
const batches=(samples)=>samples.slice(1).map((n,i)=>n-samples[i]);
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 // (1) The first frame shows at most 20 turns; the rest mount in later batches of at most 20, all 80 in the end.
 set({items:seed(80),snap:snapOf('s1'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 const tap1=sampleMounts();
 render(h(Transcript,{}),document.getElementById('app'));
 if(!await waitFor(()=>turns()===80,5000)) { tap1.stop(); throw Error('never mounted all 80, got '+turns()); }
 tap1.stop();
 if(!tap1.samples.length||tap1.samples[0]>20) throw Error('first frame shows '+tap1.samples[0]+' turns, want <= 20');
 if(tap1.samples.length<2) throw Error('did not mount in batches: '+tap1.samples.join(','));
 if(batches(tap1.samples).some((n)=>n<1||n>20)) throw Error('a batch out of 1..20: '+tap1.samples.join(','));
 // (2) The newest message does not move while older batches mount above it.
 // Pin to the bottom synchronously before reading: the session switch schedules its own
 // bottom scroll on a later frame, and the comparison must be bottom-against-bottom.
 const pin=()=>{const sc=document.querySelector('.transcript');sc.scrollTop=sc.scrollHeight;};
 set({items:seed(80),snap:snapOf('s2'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 await frame(); await frame();
 pin();
 const firstTop=document.querySelectorAll('.transcript-inner > section.turn')[turns()-1].getBoundingClientRect().top;
 if(!await waitFor(()=>turns()===80,5000)) throw Error('second session never reached 80');
 pin();
 const lastTop=document.querySelectorAll('.transcript-inner > section.turn')[79].getBoundingClientRect().top;
 if(Math.abs(lastTop-firstTop)>1) throw Error('newest message moved: '+firstTop+' -> '+lastTop);
 // (3) A streamed message arriving mid-mount lands at the bottom, not lost, not doubled.
 set({items:seed(80),snap:snapOf('s4'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 await frame();
 set({items:[...state.items,user('u-live','a live question at the end'),live(999,'a live answer at the end')]});
 if(!await waitFor(()=>turns()===81,5000)) throw Error('did not settle at 81 after stream, got '+turns());
 await wait(300);
 const last=document.querySelectorAll('.transcript-inner > section.turn')[80];
 if(!last.textContent.includes('a live answer at the end')) throw Error('streamed turn is not last');
 const el=document.querySelector('.transcript');
 if(el.scrollHeight-el.clientHeight-el.scrollTop>2) throw Error('not at bottom after streamed batch');
 // (4) Typing gets its frames to itself: while keys keep coming no batch mounts, and mounting goes on after.
 const key=()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));
 key();
 const typing=setInterval(key,30);
 set({items:seed(80),snap:snapOf('s5'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 await wait(400);
 const during=turns();
 clearInterval(typing);
 if(during>20) throw Error('turns mounted while keys kept coming: '+during);
 if(!await waitFor(()=>turns()===80,5000)) throw Error('mounting did not go on after the typing, got '+turns());
 // (5) Same batching with motion off (data-motion is off; batching is not an animation).
 if(document.documentElement.dataset.motion!=='off') throw Error('data-motion is not off: '+document.documentElement.dataset.motion);
 const tap5=sampleMounts();
 set({items:seed(80),snap:snapOf('s6'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 if(!await waitFor(()=>tap5.samples.length>0,3000)) { tap5.stop(); throw Error('motion=off never rendered'); }
 if(!await waitFor(()=>turns()===80,5000)) { tap5.stop(); throw Error('motion=off never reached 80'); }
 tap5.stop();
 if(!tap5.samples.length||tap5.samples[0]>20) throw Error('motion=off first frame shows '+tap5.samples[0]+' turns, want <= 20');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Transcript chunked mount",
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
