import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
const FULL_TEXT = `${Array.from({ length: 60 }, (_, i) => `## section ${i + 1}\nbody line for the full text, long enough to wrap inside the card.`).join("\n")}\n`;

// A read-only export copy has no workspace, so an attachment card unfolds its full text in place. The fold opens on a
// one-line loading note and the file replaces it afterwards: that second growth is an in-place swap, so it has to
// follow the height motion every other in-place swap uses instead of jumping. A card opened near the bottom must also
// keep the reader's place, like an opened diff row does.
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"an attachment's inline full text grows into place and the card that opened it holds its place",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-attach-fulltext-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			server.route("POST", "/api/uploads/info-batch", ({ body }) => {
				const paths = Array.isArray((body as { paths?: unknown })?.paths)
					? (body as { paths: string[] }).paths
					: [];
				return { results: paths.map((path) => ({ path, ok: true, meta: { exists: true, size: 4096, path } })) };
			});
			// A read that takes a moment keeps the loading note on screen, so the swap (note -> file) is the growth
			// under test rather than the opening fold.
			server.route("GET", "/api/uploads/read", async () => {
				await new Promise((resolve) => setTimeout(resolve, 120));
				return { exists: true, kind: "text", mimeType: "text/markdown", content: FULL_TEXT, truncated: true };
			});
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
const seed=()=>{const items=[];for(let i=0;i<14;i++)items.push(user('u'+i,'seed line '+i+' with enough words to wrap into a tall transcript area'),live(i,'answer '+i));items.push({...user('u-file','here is the file'),attachments:[{path:'C:/fixture/memory.md',name:'memory.md'}]});return items;};
const atBottom=()=>{const el=document.querySelector('.transcript');return el.scrollHeight-el.clientHeight-el.scrollTop<=2;};
const waitFor=async(cond,ms)=>{const t0=Date.now();while(Date.now()-t0<ms){if(cond())return true;await wait(50);}return cond();};
try {
 document.documentElement.dataset.motion='on';
 // A read-only export copy: the card has no workspace to open the file in, so it unfolds the full text instead.
 globalThis.__MYHARNESS_EXPORT__={fetch:(url,init)=>globalThis.fetch(url,init)};
 setView({lang:'en',processDefault:'collapsed'});
 set({items:seed(),snap:snapOf('s1'),toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});
 render(h(Transcript,{}),document.getElementById('app'));
 if(!await waitFor(atBottom,3000)) throw Error('not at bottom after mount');
 // The buttons only appear once the file's size is known.
 if(!await waitFor(()=>{const card=document.querySelector('.attach-card');return !!card&&!!card.querySelector('.attach-btns button');},3000)) throw Error('attachment card never got its buttons');
 const el=document.querySelector('.transcript');
 const card=document.querySelector('.attach-card');
 const buttons=card.querySelectorAll('.attach-btns button');
 if(buttons.length!==2) throw Error('expected the read and download buttons only, got '+buttons.length);
 const startHeight=card.getBoundingClientRect().height;
 const startTop=card.getBoundingClientRect().top;
 const startScroll=el.scrollTop;
 if(startTop<40||startTop>520) throw Error('card is not on screen: top='+startTop);
 const samples=[];
 let sampling=true;
 const t0=performance.now();
 const tick=()=>{if(!sampling)return;samples.push({t:performance.now()-t0,h:card.getBoundingClientRect().height});requestAnimationFrame(tick);};
 requestAnimationFrame(tick);
 buttons[0].click();
 await wait(1000);
 sampling=false;
 const heights=samples.map(s=>s.h);
 const endHeight=heights[heights.length-1];
 if(!(endHeight-startHeight>=150)) throw Error('full text did not open: '+startHeight+' -> '+endHeight);
 let maxStep=0,grownAt=null,settledAt=null;
 for(let i=1;i<heights.length;i++){
  maxStep=Math.max(maxStep,Math.abs(heights[i]-heights[i-1]));
  if(grownAt===null&&heights[i]-startHeight>=20) grownAt=samples[i].t;
  if(settledAt===null&&heights[i]>=endHeight-1) settledAt=samples[i].t;
 }
 if(grownAt===null||settledAt===null) throw Error('the full text never grew in: '+heights.join(','));
 if(settledAt-grownAt<120) throw Error('the file replaced the loading note in one frame: growth spanned '+(settledAt-grownAt)+'ms, heights='+heights.join(','));
 if(maxStep>120) throw Error('the card jumped '+maxStep+'px in one frame: '+heights.join(','));
 const topAfter=card.getBoundingClientRect().top;
 if(Math.abs(topAfter-startTop)>2) throw Error('the card moved: '+startTop+' -> '+topAfter);
 if(el.scrollTop<startScroll-2) throw Error('the view was pulled down while the text opened: '+startScroll+' -> '+el.scrollTop);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed maxStep='+maxStep.toFixed(1)+' span='+Math.round(settledAt-grownAt)+' frames='+heights.length+'</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Attachment full text motion",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
