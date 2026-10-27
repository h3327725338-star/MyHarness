import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// Quote and Translate work on an answer that is still streaming: the text keeps arriving below (and the finished part
// above grows paragraph by paragraph) between selecting a passage and pressing the bubble's button.
const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"quote and translate a passage of an answer that is still streaming",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "quote-streaming-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/vendor-md/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
				files: ["marked.min.js", "highlight.min.js"],
			});
			server.route("GET", "/api/translate", () => ({ preference: "auto", target: "zh-CN" }));
			server.route("POST", "/api/translate", () => ({ text: "translated", target: "zh-CN", model: "m" }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><script src="/vendor-md/marked.min.js"></script><div id="app" style="height:900px;display:flex;flex-direction:column"></div><div id="qh"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {FloatingQuoteToolbar} from '/js/quote-toolbar.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const snap={cwd:'C:/t',active:true,trust:{trusted:true},flags:{},session:{id:'s1',file:'C:/fixture/s1.jsonl'},thinking:{},run:{},queue:{},app:{}};
const user={kind:'user',id:'u1',ts:1,text:'give me two exercises',images:[]};
const answer=(text)=>({kind:'assistant',id:'a1',liveId:'L1',ts:2,model:'m',blocks:[{type:'text',text}],stopReason:'stop'});
const show=(text)=>set({items:[user,answer(text)],snap,toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
const P1='Two exercises. No skeleton this time, you write the whole file.';
let text=P1+'\\n\\nBoth stay inside what you have learned';
// The answer keeps streaming: a few words every 50 ms, and a new paragraph every eighth update.
let ticks=0;
let streaming=null;
const stream=()=>{streaming=setInterval(()=>{ticks++;text+=ticks%8===0?'.\\n\\nNext part '+ticks:' word'+ticks;show(text);},50);};
const stop=()=>clearInterval(streaming);
const select=(needle)=>{
 const host=document.querySelector('.final');
 const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const at=node.nodeValue.indexOf(needle);
  if(at>=0){const r=document.createRange();r.setStart(node,at);r.setEnd(node,at+needle.length);const s=getSelection();s.removeAllRanges();s.addRange(r);return;}
 }
 throw Error('text not found: '+needle);
};
const bubble=()=>document.querySelector('.floating-quote-bar');
const press=(label)=>[...document.querySelectorAll('.floating-quote-btn')].find((b)=>b.textContent.includes(label))?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
const results=[];
try{
 setView({lang:'en',motion:'off'});
 show(text);
 render(h(Transcript,{}),document.getElementById('app'));
 render(h(FloatingQuoteToolbar,{}),document.getElementById('qh'));
 await wait(300);
 must(document.querySelector('.final.streaming'),'the answer is not streaming');
 stream();
 for(const action of ['Quote','Translate']){
  await wait(120);
  select('skeleton');
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:300,clientY:100}));
  await wait(60);
  must(bubble(),action+': no bubble for the selection');
  // The user moves to the button while the answer keeps arriving (past a new paragraph).
  await wait(500);
  must(bubble(),action+': the bubble went away while the answer streamed; selection='+JSON.stringify(getSelection().toString()));
  press(action);
  await wait(150);
  const card=document.querySelector('.quote-note-card');
  results.push(action+':'+(card?'card':'none'));
  must(card,action+': pressing it did nothing; selection='+JSON.stringify(getSelection().toString()));
  if(action==='Translate') must(card.textContent.includes('skeleton')||card.textContent.includes('translated'),'translate card text: '+card.textContent.slice(0,120));
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await wait(400);
 }
 stop();
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed '+results.join(',')+'</p>');
}catch(error){stop();document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+' | '+results.join(',')+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Quote while streaming",
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
