import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// The page script runs inside a headless browser: it must not contain backticks or ${ ... } sequences and it has to
// leave its evidence in the DOM (a stuck run still has to be readable from the page snapshot).
const BROWSER_JS = `
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView,state} from '/js/store.js';
const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
const boot=document.getElementById('boot');
const report=(stats)=>boot.textContent='done '+JSON.stringify(stats);
const samples=[];
let currentLen=0;
let mutations=0;
let phase='setup';
setTimeout(()=>{if(phase!=='done')report({stuck:phase,samples:samples.length,len:currentLen,mutations:mutations});},90000);
let lastSampleT=0;
function takeSample(force){
  const now=performance.now();
  if(!force&&now-lastSampleT<100)return;
  lastSampleT=now;
  const box=document.querySelector('.thinking-text');
  if(!box)return;
  const md=box.querySelector('.md');
  let wsPre=0;
  if(md){
    const kids=md.children;
    for(let i=0;i<kids.length;i++){try{if(getComputedStyle(kids[i]).whiteSpace==='pre')wsPre++;}catch(e){}}
  }
  samples.push({ph:phase,len:currentLen,pre:box.querySelectorAll('pre').length,sw:box.scrollWidth,cw:box.clientWidth,sh:box.scrollHeight,wsPre:wsPre,strong:box.querySelectorAll('strong').length,stars:box.textContent.indexOf('**')!==-1?1:0});
  if(samples.length>4000)samples.splice(0,samples.length-4000);
}
function chunk(i){
  return 'Thought '+i+': the model weighs **plan-'+i+'** against the alternatives, checking each constraint of the task in turn and noting where the evidence is still thin and needs another look soon. ' +
    'It re-reads the failing output line by line, then sketches a narrower hypothesis with **bold-'+i+'** marked as the key claim to verify next in this long paragraph of reasoning text. ' +
    'A very long single line follows with many words separated by spaces so that an unwrapped placeholder box would surely overflow its container width and reveal itself in this streaming thought number '+i+'. ' +
    'Finally it records the open questions for the next step before moving on to consider more detail in depth once more.\\n\\n';
}
function assistantItem(text,final){
  return {kind:'assistant',id:'a1',liveId:'L1',ts:2,model:'m',blocks:[{type:'thinking',text:text}],stopReason:final?'stop':'toolUse',final:final};
}
let loopMs=0;
let flipMs=0;
try{
  setView({lang:'en',motion:'off',processDefault:'expanded'});
  let text='**Opening** the reasoning with a short paragraph far below the large-text threshold.\\n\\nSecond short paragraph to form the card body.\\n\\n';
  currentLen=text.length;
  set({items:[{kind:'user',id:'u1',ts:1,text:'go',images:[]},assistantItem(text,false)],snap:{active:true,cwd:'C:/t',flags:{},session:{id:'t1'},thinking:{supported:true},run:{startedAt:Date.now()}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[]});
  render(h(Transcript,{}),document.getElementById('app'));
  let waited=0;
  while(!document.querySelector('.thinking .group-head')&&waited<8000){await wait(50);waited+=50;}
  const head=document.querySelector('.thinking .group-head');
  if(!head)throw Error('SETUP thinking head missing');
  const obs=new MutationObserver(()=>{mutations++;takeSample(false);});
  obs.observe(document.getElementById('app'),{childList:true,subtree:true});
  if(head.getAttribute('aria-expanded')!=='true')head.click();
  waited=0;
  while(!document.querySelector('.thinking-text')&&waited<8000){await wait(50);waited+=50;}
  if(!document.querySelector('.thinking-text'))throw Error('SETUP thinking-text never mounted');
  phase='stream';
  takeSample(true);
  const loopStart=performance.now();
  // Eight cumulative updates of four closed paragraphs each: the text crosses the 16000-character async threshold and
  // every step closes more paragraphs while the previous parse is still running.
  for(let i=1;i<=8;i++){
    text+=chunk(i*4-3)+chunk(i*4-2)+chunk(i*4-1)+chunk(i*4);
    currentLen=text.length;
    const items=state.items.slice();
    items[1]=assistantItem(text,false);
    set({items:items});
    takeSample(true);
    await wait(50);
  }
  loopMs=Math.round(performance.now()-loopStart);
  if(currentLen<=20000)throw Error('SETUP only reached '+currentLen+' chars');
  phase='post';
  const items2=state.items.slice();
  items2[1]=assistantItem(text,true);
  const flipStart=performance.now();
  set({items:items2});
  takeSample(true);
  waited=0;
  while(waited<30000&&!document.querySelector('.thinking-text strong')){await wait(50);waited+=50;}
  flipMs=Math.round(performance.now()-flipStart);
  for(let k=0;k<8;k++){await wait(50);takeSample(true);}
  phase='done';
  obs.disconnect();
  const stream=samples.filter((s)=>s.ph==='stream');
  const post=samples.filter((s)=>s.ph==='post');
  const errs=[];
  const preTotal=samples.reduce((n,s)=>n+s.pre,0);
  if(preTotal>0)errs.push('A pre appeared in samples (preTotal='+preTotal+')');
  const over=samples.filter((s)=>s.sw>s.cw+2);
  if(over.length){let worst=0;for(const s of over){if(s.sw-s.cw>worst)worst=s.sw-s.cw;}errs.push('B overflow in '+over.length+' samples (worst sw-cw='+worst+')');}
  const wsBad=samples.filter((s)=>s.wsPre>0);
  if(wsBad.length)errs.push('B whiteSpace=pre in '+wsBad.length+' samples');
  // A closed paragraph moves out of the plain-text tail into parsed Markdown, which can re-wrap it by about one line:
  // that settle is expected. The old placeholder flipped the whole card, which moves it by hundreds of pixels.
  const LINE=40;
  let minSh=0;let maxSh=0;let peak=0;let jumps=0;let worstJump=0;let firstLen=-1;let lastLen=0;
  for(const s of stream){if(firstLen<0){minSh=s.sh;maxSh=s.sh;peak=s.sh;firstLen=s.len;}if(s.sh>maxSh)maxSh=s.sh;if(s.sh<minSh)minSh=s.sh;if(s.sh<peak-LINE){jumps++;if(peak-s.sh>worstJump)worstJump=peak-s.sh;}if(s.sh>peak)peak=s.sh;lastLen=s.len;}
  if(jumps>0)errs.push('B scrollHeight jumped back in '+jumps+' streaming samples (worst='+worstJump+'px min='+minSh+' max='+maxSh+')');
  const endBox=document.querySelector('.thinking-text');
  const endStrong=endBox?endBox.querySelectorAll('strong').length:-1;
  const endStars=endBox?endBox.textContent.indexOf('**')!==-1:-1;
  const endPre=endBox?endBox.querySelectorAll('pre').length:-1;
  if(!(endStrong>0))errs.push('C missing <strong>');
  if(endStars!==false)errs.push('C literal ** still visible');
  if(endPre!==0)errs.push('C <pre> present at end');
  let postPre=0;let postMin=0;let postFirst=true;
  for(const s of post){postPre+=s.pre;if(postFirst){postMin=s.sh;postFirst=false;}if(s.sh<postMin)postMin=s.sh;}
  if(postPre>0)errs.push('D <pre> in post-final window (postPre='+postPre+')');
  const lastStreamSh=stream.length?stream[stream.length-1].sh:0;
  if(!postFirst&&postMin<lastStreamSh-LINE)errs.push('D post scrollHeight regressed (postMin='+postMin+' lastStream='+lastStreamSh+')');
  const stats={samples:samples.length,stream:stream.length,post:post.length,mutations:mutations,charsFrom:firstLen,charsTo:lastLen,loopMs:loopMs,flipMs:flipMs,minSh:minSh,maxSh:maxSh,lineTolerance:LINE,preTotal:preTotal,overflow:over.length,wsBad:wsBad.length,jumps:jumps,worstJump:worstJump,endStrong:endStrong,endPre:endPre,endStars:endStars?1:0,postMin:postMin,lastStreamSh:lastStreamSh,failed:errs.join(' | ')};
  if(errs.length)throw Error('ASSERT '+errs.join(' | '));
  report(stats);
}catch(error){
  const box=document.querySelector('.thinking-text');
  const partial={phase:phase,samples:samples.length,len:currentLen,mutations:mutations,loopMs:loopMs,flipMs:flipMs,pre:box?box.querySelectorAll('pre').length:-1,strong:box?box.querySelectorAll('strong').length:-1,failed:String((error&&error.message)||error)};
  report(partial);
  const p=document.createElement('p');p.id='page-error';p.textContent=String((error&&error.stack)||error);document.body.append(p);
}
`;

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"long thinking stream never swaps between placeholder and parsed layout",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "thinking-flicker-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installed[0]!.kind, rootDir: join(root, "browser") });
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				[
					"<!doctype html>",
					'<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css">',
					'<link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css">',
					'<div id="app"></div><div id="boot">boot</div>',
					"<script>",
					"window.addEventListener('error',function(e){document.getElementById('boot').textContent='done PAGE-ERROR '+(e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||'');});",
					"window.addEventListener('unhandledrejection',function(e){document.getElementById('boot').textContent='done PAGE-REJECT '+((e.reason&&e.reason.stack)||e.reason);});",
					"</script>",
					'<script src="/markdown/marked.min.js"></script>',
					'<script type="module" src="/test/test.js"></script>',
				].join(""),
			);
			writeFileSync(join(root, "test.js"), BROWSER_JS);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#boot",
				label: "Thinking flicker",
				isSolved: (candidate) => candidate.text.includes('id="boot">done'),
			});
			const statsMatch = page.text.match(/id="boot">done ([^<]*)<\/div>/);
			const stats = statsMatch ? (JSON.parse(statsMatch[1]) as Record<string, number | string>) : null;
			// eslint-disable-next-line no-console
			console.log(`[thinking-flicker] stats=${statsMatch ? statsMatch[1] : "missing"}`);
			expect(page.text, "page reported an error").not.toContain('id="page-error"');
			expect(stats, "browser stats missing").toBeTruthy();
			expect(stats!.failed, "in-page assertions").toBe("");
			// A: no <pre> placeholder at any sample.
			expect(stats!.preTotal, "A: .thinking-text pre count").toBe(0);
			// B: no wrap change: no horizontal overflow, no white-space:pre, no layout jump back beyond one line.
			expect(stats!.overflow, "B: scrollWidth overflow samples").toBe(0);
			expect(stats!.wsBad, "B: whiteSpace=pre samples").toBe(0);
			expect(stats!.jumps, "B: layout jump-back samples").toBe(0);
			expect(Number(stats!.worstJump), "B: worst scrollHeight jump back (px)").toBeLessThan(40);
			// C: markdown really parsed at the end (all of it, not just the first paragraphs).
			expect(stats!.endStrong, "C: <strong> count").toBeGreaterThan(10);
			expect(stats!.endPre, "C: <pre> count at the end").toBe(0);
			expect(stats!.endStars, "C: literal ** left at the end").toBe(0);
			// D: the final flip keeps the layout; no placeholder frame afterwards.
			expect(stats!.post, "D: post-final samples").toBeGreaterThan(0);
			expect(Number(stats!.postMin), "D: post scrollHeight regression").toBeGreaterThanOrEqual(
				Number(stats!.lastStreamSh) - 40,
			);
			// The stream really did cross the async threshold and grow well past it.
			expect(Number(stats!.charsTo), "chars streamed").toBeGreaterThan(20000);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	// Headless Firefox needs tens of seconds for this page, and more while the machine is busy with other work.
	300_000,
);
