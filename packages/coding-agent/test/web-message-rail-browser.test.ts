import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"message index rail follows the conversation, jumps and scrubs, and a quote leads back to its source",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-rail-"));
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
				files: ["marked.min.js"],
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><script src="/vendor-md/marked.min.js"></script><div id="app" style="height:600px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView,state} from '/js/store.js';
const mark=(m)=>{document.title=m;};
setTimeout(()=>{if(!document.getElementById('ready'))document.body.insertAdjacentHTML('beforeend','<p id="ready">STALL at '+document.title+' ticks='+document.querySelectorAll('.msg-tick').length+'</p>');},15000);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const user=(id,text)=>({kind:'user',id,ts:1,text,images:[]});
const live=(n,text)=>({kind:'assistant',id:'a'+n,liveId:'L'+n,ts:2,model:'m',blocks:[{type:'text',text}],stopReason:'stop',final:text});
const snapOf=(id)=>({cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id,file:'C:/fixture/'+id+'.jsonl'},thinking:{},run:{},queue:{},app:{}});
const PASSAGE='the zebra crossed the quiet river at dawn';
const seed=()=>{const items=[];for(let i=0;i<25;i++){items.push(user('u'+i,'seed line '+i+' with enough words to wrap into a tall transcript area'),live(i,i===3?'Notes: '+PASSAGE+'. Then more text follows here.':'answer '+i+' '+'filler words '.repeat(30)));}items.push(user('uq','> '+PASSAGE+'\\n\\nwhat about this?'),live(99,'reply'));return items;};
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(50);}return cond();};
const ptr=(el,type,y)=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientY:y,clientX:el.getBoundingClientRect().left+5,pointerId:1,button:0}));
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 set({items:seed(),snap:snapOf('s1'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),document.getElementById('app'));
 const el=()=>document.querySelector('.transcript');
 if(!await waitFor(()=>document.querySelectorAll('.msg-tick').length>=20&&document.querySelectorAll('.msg-tick').length===document.querySelectorAll('section.turn[data-turn-key]').length,4000)) throw Error('ticks: '+document.querySelectorAll('.msg-tick').length);
 mark('ticks');
 // The last message is the lit one while the conversation rests at the bottom.
 if(!await waitFor(()=>{const t=[...document.querySelectorAll('.msg-tick')];return t[t.length-1].classList.contains('on');},2000)) throw Error('last tick not lit at bottom');
 mark('lit');
 // A click on the first tick glides to the first message.
 const rail=document.querySelector('.msg-rail');
 const ticks=[...document.querySelectorAll('.msg-tick')];
 const y0=ticks[0].getBoundingClientRect().top;
 ptr(rail,'pointermove',y0); await wait(80);
 if(!document.querySelector('.msg-tip')) throw Error('no tip while aiming');
 ptr(rail,'pointerdown',y0); ptr(rail,'pointerup',y0);
 if(!await waitFor(()=>el().scrollTop<4,3000)) throw Error('did not reach the first message: '+el().scrollTop);
 if(!await waitFor(()=>document.querySelectorAll('.msg-tick')[0].classList.contains('on'),2000)) throw Error('first tick not lit at top: top='+el().scrollTop+' on='+[...document.querySelectorAll('.msg-tick')].findIndex(x=>x.classList.contains('on')));
 mark('first');
 // Scrubbing: pressing and dragging scrolls instantly with the pointer.
 const y12=ticks[12].getBoundingClientRect().top;
 ptr(rail,'pointerdown',y0); ptr(rail,'pointermove',y0+12); ptr(rail,'pointermove',y12); ptr(rail,'pointerup',y12);
 await wait(200);
 const m12=document.querySelectorAll('section.turn[data-turn-key]')[12].getBoundingClientRect().top-el().getBoundingClientRect().top;
 if(Math.abs(m12-14)>6) throw Error('scrub did not land message 12 at the top: '+m12);
 mark('scrub');
 // The quote in the last message leads to its source (assistant text of turn 3) and offers the way back.
 el().scrollTop=el().scrollHeight; el().dispatchEvent(new Event('scroll',{bubbles:true})); await wait(150);
 const bq=document.querySelector('.user-bubble blockquote');
 if(!bq) throw Error('no blockquote: bubbles='+document.querySelectorAll('.user-bubble').length+' last='+[...document.querySelectorAll('.user-bubble')].pop()?.innerHTML.slice(0,300).replace(/</g,'[')+' top='+el().scrollTop+'/'+el().scrollHeight);
 const before=el().scrollTop;
 bq.click();
 if(!await waitFor(()=>document.querySelector('.nav-back')!==null,3000)) throw Error('no back pill');
 await wait(400);
 const sources=[...document.querySelectorAll('.final')].find(n=>n.textContent.includes(PASSAGE));
 const at=sources.getBoundingClientRect().top-el().getBoundingClientRect().top;
 if(at<0||at>el().clientHeight*0.6) throw Error('source not in view: '+at);
 if(!(CSS.highlights&&CSS.highlights.has('myharness-jump'))&&!document.querySelector('.quote-hl')) throw Error('no landing flash');
 document.querySelector('.nav-back').click();
 if(!await waitFor(()=>Math.abs(el().scrollTop-before)<6,3000)) throw Error('back did not return: '+before+' vs '+el().scrollTop);
 // Scrolling back to where the jump started takes the way-back control away by itself, and it never sits beside the jump button.
 document.querySelector('.user-bubble blockquote').click();
 if(!await waitFor(()=>document.querySelector('.nav-back')!==null,3000)) throw Error('no back pill the second time');
 await wait(400);
 if(getComputedStyle(document.querySelector('.jump-btn')||document.body).display!=='none'&&document.querySelector('.jump-btn')) throw Error('jump button shown beside the back pill');
 el().scrollTop=before; el().dispatchEvent(new Event('scroll',{bubbles:true}));
 if(!await waitFor(()=>document.querySelector('.nav-back')===null,2000)) throw Error('back pill stayed after returning by hand');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">['+document.title+'] '+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Message rail",
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
