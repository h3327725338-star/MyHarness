import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"mounts transcript turns in chunks: 20 on the first frame, all 60 within 4 frames",
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
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 // (1) First frame shows at most 20 turns, all 60 within 4 frames.
 set({items:seed(80),snap:snapOf('s1'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 const tap1=sampleMounts();
 render(h(Transcript,{}),document.getElementById('app'));
 if(!await waitFor(()=>turns()===60,3000)) { tap1.stop(); throw Error('never settled at 60'); }
 tap1.stop();
 if(!tap1.samples.length||tap1.samples[0]>20) throw Error('first frame shows '+tap1.samples[0]+' turns, want <= 20');
 if(tap1.samples.length>4) throw Error('took '+tap1.samples.length+' frames to reach 60: '+tap1.samples.join(','));
 // (5) The newest message does not move while older chunks mount above it.
 // Pin to the bottom synchronously before reading: the session switch schedules its own
 // bottom scroll on a later frame, and the comparison must be bottom-against-bottom.
 const pin=()=>{const sc=document.querySelector('.transcript');sc.scrollTop=sc.scrollHeight;};
 set({items:seed(80),snap:snapOf('s2'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 await frame(); await frame();
 pin();
 const firstTop=document.querySelectorAll('.transcript-inner > section.turn')[turns()-1].getBoundingClientRect().top;
 if(!await waitFor(()=>turns()===60,3000)) throw Error('second session never reached 60');
 pin();
 const lastTop=document.querySelectorAll('.transcript-inner > section.turn')[59].getBoundingClientRect().top;
 if(Math.abs(lastTop-firstTop)>1) throw Error('newest message moved: '+firstTop+' -> '+lastTop);
 // (2) Hitting "Show earlier" mid-chunk mounts everything at once, without duplicates.
 set({items:seed(80),snap:snapOf('s3'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 await frame();
 const earlier=document.querySelector('button.earlier');
 if(!earlier) throw Error('earlier button missing mid-chunk');
 earlier.click();
 if(!await waitFor(()=>turns()===80,3000)) throw Error('show-earlier did not mount all 80 turns, got '+turns());
 const finals=[...document.querySelectorAll('.transcript-inner > section.turn .final')].map((el)=>el.textContent);
 const uniq=new Set(finals);
 if(uniq.size!==80) throw Error('duplicate turns after show-earlier: '+finals.length+' rendered, '+uniq.size+' unique');
 // (3) A streamed message arriving mid-chunk lands at the bottom, not lost, not doubled.
 // The window stays capped at 60: the new turn slides in at the end and the oldest slides out.
 set({items:seed(80),snap:snapOf('s4'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 await frame();
 set({items:[...state.items,user('u-live','a live question at the end'),live(999,'a live answer at the end')]});
 if(!await waitFor(()=>turns()===60,5000)) throw Error('window did not settle at 60 after stream, got '+turns());
 await wait(300);
 const last=document.querySelectorAll('.transcript-inner > section.turn')[59];
 if(!last.textContent.includes('a live answer at the end')) throw Error('streamed turn is not last');
 const el=document.querySelector('.transcript');
 if(el.scrollHeight-el.clientHeight-el.scrollTop>2) throw Error('not at bottom after streamed chunk');
 // (4) Same chunking with motion off (data-motion is off; chunking is not an animation).
 if(document.documentElement.dataset.motion!=='off') throw Error('data-motion is not off: '+document.documentElement.dataset.motion);
 const tap5=sampleMounts();
 set({items:seed(80),snap:snapOf('s5'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 // Wait for the first commit first: the old DOM still shows 60 until the switch renders.
 if(!await waitFor(()=>tap5.samples.length>0,3000)) { tap5.stop(); throw Error('motion=off never rendered'); }
 if(!await waitFor(()=>turns()===60,3000)) { tap5.stop(); throw Error('motion=off never reached 60'); }
 tap5.stop();
 if(!tap5.samples.length||tap5.samples[0]>20) throw Error('motion=off first frame shows '+tap5.samples[0]+' turns, want <= 20');
 if(tap5.samples.length>4) throw Error('motion=off took '+tap5.samples.length+' frames: '+tap5.samples.join(','));
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
