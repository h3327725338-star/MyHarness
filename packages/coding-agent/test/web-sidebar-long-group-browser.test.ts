import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"folds a blank chat that was left at once, also in a group longer than its shown rows",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "sidebar-long-group-"));
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
				`<!doctype html>${["tokens", "base", "layout"].map((n) => `<link rel="stylesheet" href="/css/${n}.css">`).join("")}<div id="app" style="width:300px;height:900px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>`,
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {activateSlot,loadSlots,loadUnbound,set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
const must=(x,m)=>{if(!x)throw Error(m)};
const now=Date.now();
const DIR='C:/agent/default';
const info=(slot,file,extra={})=>({slot,mode:'general',sessionId:slot,sessionFile:file,cwd:DIR,name:null,firstMessage:'',hasContent:false,active:false,waiting:false,completion:false,unbound:true,atDefaultDir:true,copy:false,...extra});
const slots={blank:info('blank','C:/d/blank.jsonl')};
// Fourteen chats: more than the twelve a group shows, so the row below the cut comes back when one above it leaves.
const saved=Array.from({length:14},(_,i)=>({path:'C:/d/c'+i+'.jsonl',id:'c'+i,name:'Chat '+i,firstMessage:'q',messageCount:2,modified:now-(i+1)*60000}));
window.fetch=async(url,init={})=>{
 const slot=init.headers?.['x-myharness-slot']||'';
 if(url==='/api/sessions/open'){await wait(200);slots.c0=info('c0','C:/d/c0.jsonl',{hasContent:true,firstMessage:'q',name:'Chat 0'});return new Response(JSON.stringify({slot:'c0',created:true}));}
 if(url==='/api/state')return new Response(JSON.stringify({slot,mode:'general',cwd:DIR,session:{id:slots[slot]?.sessionId,file:slots[slot]?.sessionFile,persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},model:{id:'m',input:['text']},thinking:{level:'off',levels:[]},trust:{trusted:true},run:{},app:{}}));
 if(url.startsWith('/api/transcript'))return new Response(JSON.stringify({items:[]}));
 if(url==='/api/slots')return new Response(JSON.stringify({slots:Object.values(slots)}));
 if(url.startsWith('/api/sessions/unbound'))return new Response(JSON.stringify({sessions:saved}));
 if(url.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(url.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(url==='/api/resources')return new Response(JSON.stringify({commands:[],tools:[],skills:[],templates:[],extensions:[]}));
 return new Response('{}');
};
try{
 document.documentElement.dataset.motion='on';
 setView({lang:'en',motion:'on',chatMode:'general',sidebarOpen:true});
 set({connected:true});
 await loadSlots();
 await loadUnbound('general');
 await activateSlot('blank');
 render(h(Sidebar,{}),document.getElementById('app'));
 await wait(600);
 const blankFold=()=>[...document.querySelectorAll('.chat-slot')].find(n=>n.textContent.includes('New chat'))?.querySelector(':scope > .collapse');
 const titles=()=>[...document.querySelectorAll('.chat-slot .title')].map(n=>n.textContent);
 must(blankFold()?.classList.contains('open'),'the blank chat on screen is not listed: '+titles().join('|'));
 must(!titles().includes('Chat 11')&&titles().includes('Chat 10'),'the fixture group is not cut at twelve rows: '+titles().join('|'));
 [...document.querySelectorAll('.chat-row')].find(n=>n.textContent.includes('Chat 0')).click();
 await frame(); await frame();
 must(blankFold()&&!blankFold().classList.contains('open'),'the blank chat that was left did not start folding at once');
 await wait(600);
 must(!titles().includes('New chat')&&titles().includes('Chat 11'),'after the fold: '+titles().join('|'));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Sidebar long group",
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
