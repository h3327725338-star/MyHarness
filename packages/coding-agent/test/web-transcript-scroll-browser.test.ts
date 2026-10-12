import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps the transcript pinned to the bottom, one scroll write per frame, diff rows hold their place",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-scroll-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			server.route("GET", "/api/changes/card-diff", () => ({
				summary: { binary: false },
				patch: `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,7 +1,40 @@
${Array.from({ length: 30 }, (_, i) => ` line ${i + 1}`).join("\n")}
+added one
+added two
+added three`,
			}));
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
const seed=(id,count)=>{const items=[];for(let i=0;i<count;i++)items.push(user('u'+i,'seed line '+i+' with enough words to wrap into a tall transcript area'),live(i,'answer '+i));return items;};
const atBottom=()=>{const el=document.querySelector('.transcript');return el.scrollHeight-el.clientHeight-el.scrollTop<=2;};
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(50);}return cond();};
try {
 setView({lang:'en',motion:'off',processDefault:'collapsed'});
 set({items:seed('s1',25),snap:snapOf('s1'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),document.getElementById('app'));
 // (5) After opening a session the transcript rests at the bottom.
 if(!await waitFor(atBottom,3000)) throw Error('not at bottom after mount, distance='+(document.querySelector('.transcript').scrollHeight-document.querySelector('.transcript').scrollTop));
 // (1) Appending while pinned follows to the bottom.
 set({items:[...state.items,user('u-new','a fresh line at the end'),live(99,'fresh answer')]});
 if(!await waitFor(atBottom,3000)) throw Error('did not follow appended content');
 // (2) After the user scrolled up, appended content does not pull back (away, jump button shows).
 const el=document.querySelector('.transcript');
 el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120})); await wait(50);
 el.scrollTop=0; el.dispatchEvent(new Event('scroll',{bubbles:true})); await wait(150);
 if(document.querySelector('.jump-btn')===null) throw Error('jump button did not appear after scrolling up');
 const topBefore=el.scrollTop;
 set({items:[...state.items,user('u-new2','another line while away'),live(100,'another answer')]}); await wait(400);
 if(Math.abs(el.scrollTop-topBefore)>2) throw Error('pulled back while away: '+topBefore+' -> '+el.scrollTop);
 // Back to the bottom through the jump button (smooth scroll).
 document.querySelector('.jump-btn').click();
 let back=false;
 for(let i=0;i<30;i++){await wait(100);if(atBottom()){back=true;break;}}
 if(!back) throw Error('jump button did not return to bottom');
 // (3) Many triggers in the same frame produce a single scrollTop write.
 let writes=0;
 const desc=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
 Object.defineProperty(el,'scrollTop',{get(){return desc.get.call(this);},set(v){writes++;return desc.set.call(this,v);},configurable:true});
 const perFrame=[];
 set({items:[...state.items,user('u-w','write probe'),live(101,'probe answer')]});
 for(let i=0;i<4;i++){await new Promise((resolve)=>requestAnimationFrame(()=>resolve()));perFrame.push(writes);writes=0;}
 Object.defineProperty(el,'scrollTop',desc);
 if(perFrame.some((n)=>n>1)) throw Error('more than one scrollTop write in a frame: '+perFrame.join(','));
 if(perFrame.reduce((a,b)=>a+b,0)===0) throw Error('no scroll write happened at all');
 // (4) Opening a diff row holds its place: the row does not move and the view is not pulled down.
 set({items:[...state.items,{kind:'runChanges',id:'c1',ts:9,runId:1,files:[{path:'src/a.ts',status:'modified',additions:3,deletions:1,binary:false}]}]});
 if(!await waitFor(()=>document.querySelector('.change-file')!==null,3000)) throw Error('diff row missing');
 if(!await waitFor(atBottom,3000)) throw Error('not at bottom before opening diff');
 const row=document.querySelector('.change-file');
 const rowTop=row.getBoundingClientRect().top;
 const viewTop=el.scrollTop;
 row.click(); await wait(500);
 const rowTopAfter=row.getBoundingClientRect().top;
 if(Math.abs(rowTopAfter-rowTop)>2) throw Error('diff row moved: '+rowTop+' -> '+rowTopAfter);
 if(el.scrollTop<viewTop-2) throw Error('view pulled down while holding place');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Transcript scroll debounce",
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
