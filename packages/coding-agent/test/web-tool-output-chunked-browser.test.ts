// Browser lock for the chunked "Show all" of oversized tool output (W188): on a real page, a 1 MB
// bash result expands with the first block (<= 100 KB) painted in well under 100 ms, the rest is
// appended without a single > 50 ms main-thread task, the finished text is verbatim (length + SHA-1)
// with no replacement characters, collapsing mid-append stops the chain immediately, unmounting
// leaves no orphan callbacks, and a > 200 KB Markdown block degrades to a plain <pre> while a small
// one still renders as Markdown. The in-page source text is ASCII-dominant with CJK+emoji lines
// every 64th line, so multibyte characters straddle the 100 KB block boundaries.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"expands a 1 MB tool output in blocks under the long-task budget and stops on collapse",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-chunked-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("GET", "/api/settings", () => ({ items: [] }));
			server.route("GET", "/api/trust", () => ({ requiresTrust: false }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const poll=(fn,ms,label)=>new Promise((resolve,reject)=>{const t0=Date.now();const iv=setInterval(()=>{let ok=false;try{ok=fn()}catch(e){ok=false}if(ok){clearInterval(iv);resolve(Date.now())}else if(Date.now()-t0>ms){clearInterval(iv);reject(Error('timeout: '+label))}},5);});
const sha=async s=>{const b=new TextEncoder().encode(s);const d=await crypto.subtle.digest('SHA-1',b);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')};
window.__lt=[];window.__errors=[];
new PerformanceObserver(list=>{for(const e of list.getEntries())window.__lt.push({ms:e.duration,start:e.startTime})}).observe({entryTypes:['longtask']});
window.addEventListener('error',e=>window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection',e=>window.__errors.push('reject: '+String(e.reason)));
// 32768 lines of exactly 32 UTF-16 units = 1048576 chars; every 64th line carries kanji + rocket.
let src='';
for(let i=0;i<32768;i++){src+=i%64===63?'\\u6f22\\u5b57\\ud83d\\ude80'+'q'.repeat(27)+'\\n':String(i).padStart(8,'0')+'a'.repeat(23)+'\\n'}
if(src.length!==1048576)throw Error('fixture length '+src.length);
let bigMd='';while(bigMd.length<=250000){bigMd+='# Section\\n\\n'+'filler word stream for markdown body. '.repeat(9)+'\\n\\n'}
const smallMd='# Hello Markdown\\n\\nThis small block should render as **markdown**, not a pre.\\n\\nAnother paragraph here.\\n';
const snap={active:true,cwd:'C:/test',flags:{},session:{id:'chunked'},run:{startedAt:Date.now()}};
const items=[
 {kind:'user',id:'u1',ts:1,text:'show me the output',images:[]},
 {kind:'assistant',id:'a1',ts:2,model:'test',blocks:[
  {type:'toolCall',id:'c1',name:'bash',args:{command:'npm run big-one'}},
  {type:'toolCall',id:'cbig',name:'read',args:{path:'C:/test/docs/big.md'}},
  {type:'toolCall',id:'c2',name:'bash',args:{command:'npm run big-two'}},
  {type:'toolCall',id:'csmall',name:'read',args:{path:'C:/test/docs/small.md'}}]},
 {kind:'toolResult',id:'r1',toolCallId:'c1',text:src,isError:false,details:{exitCode:0,durationMs:1200},ts:3},
 {kind:'toolResult',id:'rbig',toolCallId:'cbig',text:bigMd,isError:false,details:{exitCode:0,durationMs:30},ts:4},
 {kind:'toolResult',id:'r2',toolCallId:'c2',text:src,isError:false,details:{exitCode:0,durationMs:1200},ts:5},
 {kind:'toolResult',id:'rsmall',toolCallId:'csmall',text:smallMd,isError:false,details:{exitCode:0,durationMs:20},ts:6}];
const app=document.getElementById('app');
try {
 setView({processDefault:'expanded'});
 set({items,snap,dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],models:[]});
 render(h(Transcript,{}),app); await wait(450);
 if(document.querySelector('.summary-head')?.getAttribute('aria-expanded')!=='true') throw Error('summary not expanded');
 let rows=[...document.querySelectorAll('.action-row')];
 if(rows.length!==4) throw Error('expected 4 action rows, got '+rows.length);
 const showAllBtn=scope=>[...scope.querySelectorAll('.raw-block .btn')].find(b=>/Show all/.test(b.textContent));
 const showLessBtn=scope=>[...scope.querySelectorAll('.raw-block .btn')].find(b=>/Show less/.test(b.textContent));
 // The raw card is a sibling of the row inside .action, not a descendant of the row itself.
 const rawOf=row=>{const a=row.closest('.action');const r=a&&a.querySelector('.raw');if(!r)throw Error('card did not open');return r};
 // ---- Phase 1: measure the full chunked expansion of card 1 ------------------------------------
 rows[0].click(); await wait(450);
 const raw1=rawOf(rows[0]);
 const pre1=raw1.querySelector('.raw-block pre.raw-pre');
 if(!pre1) throw Error('card 1 result pre missing');
 if(pre1.textContent.length!==20000) throw Error('card 1 preview length '+pre1.textContent.length+' (expected 20000)');
 const btn1=showAllBtn(raw1);
 if(!btn1) throw Error('card 1 Show all button missing');
 await wait(300);
 const clickStart=performance.now();
 btn1.click();
 await poll(()=>pre1.textContent.length>20000,5000,'first block paint');
 const tFirst=performance.now()-clickStart;
 const firstLen=pre1.textContent.length;
 const fullEnd=await poll(()=>pre1.textContent.length>=1048576,20000,'full text');
 const tFull=fullEnd-clickStart;
 if(tFirst>=100) throw Error('first block took '+tFirst.toFixed(1)+'ms (limit 100)');
 if(firstLen>102400) throw Error('first block is '+firstLen+' chars (limit 102400)');
 await wait(400);
 const finalText=pre1.textContent;
 if(finalText.length!==1048576) throw Error('final length '+finalText.length);
 const bad=(finalText.match(/\\uFFFD/g)||[]).length;
 if(bad!==0) throw Error(bad+' replacement characters in final text');
 const h1=await sha(finalText); const h2=await sha(src);
 if(h1!==h2) throw Error('SHA-1 mismatch '+h1+' != '+h2);
 const windowTasks=window.__lt.filter(e=>e.start>=clickStart-50&&e.start<=tFull+clickStart+250);
 const maxTask=windowTasks.length?Math.max(...windowTasks.map(e=>e.ms)):0;
 if(maxTask>=50) throw Error('long task '+maxTask.toFixed(1)+'ms during expansion (limit 50)');
 // ---- Phase 2: collapse mid-append must stop the chain immediately -------------------------------
 rows[2].click(); await wait(450);
 const raw2=rawOf(rows[2]);
 const pre2=raw2.querySelector('.raw-block pre.raw-pre');
 showAllBtn(raw2).click();
 await poll(()=>pre2.textContent.length>=204800,10000,'second block of card 2');
 const foldClick=performance.now();
 showLessBtn(raw2).click();
 await poll(()=>pre2.textContent.length===20000,200,'collapse back to preview');
 const foldMs=performance.now()-foldClick;
 await wait(800);
 if(pre2.textContent.length!==20000) throw Error('chain kept appending after collapse: '+pre2.textContent.length);
 // ---- Phase 3: unmount mid-append leaves no orphan callbacks -------------------------------------
 showAllBtn(raw2).click();
 await poll(()=>pre2.textContent.length>102400,10000,'append running before unmount');
 render(null,app);
 await wait(600);
 if(window.__errors.length) throw Error('errors after unmount: '+window.__errors.join(' | '));
 render(h(Transcript,{}),app); await wait(450);
 rows=[...document.querySelectorAll('.action-row')];
 if(rows.length!==4) throw Error('page broken after remount, rows='+rows.length);
 if(window.__errors.length) throw Error('errors after remount: '+window.__errors.join(' | '));
 // ---- Phase 4: Markdown degradation past 200 KB ---------------------------------------------------
 rows[1].click(); await wait(450);
 const rawBig=rawOf(rows[1]);
 const mdBig=rawBig.querySelector('.raw-md');
 if(!mdBig) throw Error('big markdown block missing');
 if(!mdBig.querySelector('pre.raw-pre')) throw Error('big markdown did not degrade to pre');
 if(mdBig.querySelector('h1,h2,p,ul')) throw Error('big markdown still rendering markdown elements');
 if(mdBig.querySelector('pre.raw-pre').textContent.length!==60000) throw Error('big markdown preview length wrong');
 if(!showAllBtn(rawBig)) throw Error('big markdown Show all button missing');
 rows[3].click(); await wait(450);
 const rawSmall=rawOf(rows[3]);
 const mdSmall=rawSmall.querySelector('.raw-md');
 if(!mdSmall) throw Error('small markdown block missing');
 const h1el=mdSmall.querySelector('h1');
 if(!h1el||h1el.textContent.trim()!=='Hello Markdown') throw Error('small markdown did not render heading');
 if(mdSmall.querySelector('pre.raw-pre')) throw Error('small markdown wrongly degraded to pre');
 if(showAllBtn(rawSmall)) throw Error('small markdown shows a Show all button it should not need');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed first='+tFirst.toFixed(1)+'ms firstLen='+firstLen+' full='+tFull.toFixed(0)+'ms maxlt='+maxTask.toFixed(1)+'ms fold='+foldMs.toFixed(1)+'ms</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">FAILED: '+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Tool output chunked show-all",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);
