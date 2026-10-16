import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"loads Changes after a pending slot resolves with the same session id, isolates late answers, and retries real failures",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "changes-pending-"));
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
				'<!doctype html><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {ChangesPanel} from '/js/panel-changes.js';
import {actions} from '/js/actions.js';
import {activateSlot,state,set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const until=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await wait(20)}throw Error('UI wait timed out: '+document.body.innerText)};
const calls=[];let fail=false,releaseSlow;
const realFetch=window.fetch.bind(window);
window.fetch=async(url,init={})=>{
 const slot=init.headers?.['x-myharness-slot']||'';calls.push({url,slot});
 if(url==='/api/sessions/open'){await wait(100);return new Response(JSON.stringify({slot:JSON.parse(init.body).path}));}
 if(url==='/api/state'){await wait(50);return new Response(JSON.stringify({slot,mode:'coding',cwd:'C:/fixture',session:{id:slot,file:slot,persisted:true},active:false,flags:{},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},thinking:{levels:[]},trust:{},run:{},app:{}}));}
 if(url.startsWith('/api/transcript'))return new Response(JSON.stringify({items:[]}));
 if(url.startsWith('/api/changes?')){
  if(slot==='slow')await new Promise(resolve=>{releaseSlow=resolve});else await wait(40);
  if(slot==='bad'&&fail)return new Response(JSON.stringify({error:'Loading actual diff failed'}),{status:500});
  return new Response(JSON.stringify({files:[{path:slot+'.ts',status:'modified',additions:1,deletions:0}],total:1}));
 }
 if(url.startsWith('/api/changes/diff'))return new Response(JSON.stringify({summary:{additions:1,deletions:0},patch:'--- a/'+slot+'.ts\\n+++ b/'+slot+'.ts\\n@@ -1 +1 @@\\n-old\\n+'+slot+'\\n'}));
 if(url==='/api/slots')return new Response(JSON.stringify({slots:[]}));
 if(url.startsWith('/api/workspaces'))return new Response(JSON.stringify({workspaces:[],sessions:[]}));
 if(url.includes('unbound')||url.includes('archived'))return new Response(JSON.stringify({sessions:[]}));
 if(url==='/api/resources')return new Response(JSON.stringify({commands:[]}));
 return new Response('{}');
};
try{
 setView({lang:'en',motion:'off',changesScope:'worktree'});set({connected:true});
 await activateSlot('initial');
 render(h(ChangesPanel,{}),document.getElementById('app'));
 await until(()=>document.querySelector('.cfile:not(.sk)')?.textContent.includes('initial.ts'));
 await until(()=>document.querySelector('.cdiff')?.textContent.includes('initial'));
 const start=performance.now(),opening=actions.openSession('target');
 await wait(50);
 must(state.snap.session.id===undefined||state.switching,'not testing pending target');
 must(!document.querySelector('.notice.danger'),'pending became an error');
 must(!document.querySelector('.cfile:not(.sk)'),'previous chat files remained visible during pending');
 must(!document.querySelector('.cdiff:not(.sk)'),'previous chat diff remained visible during pending');
 must(!calls.some(x=>x.slot.startsWith('pending:')),'sent API on pending slot');
 await opening;await until(()=>document.querySelector('.cfile:not(.sk)')?.textContent.includes('target.ts'));
 must(!document.querySelector('.notice.danger'),'pending error survived ready slot');
 await until(()=>document.querySelector('.cdiff')?.textContent.includes('target'));
 const readyMs=performance.now()-start;
 const refresh=document.querySelector('button[aria-label="Refresh changes"]');refresh.click();await wait(10);
 must(document.querySelector('.cfile:not(.sk)')?.textContent.includes('target.ts'),'same-chat refresh cleared existing files');
 must(document.querySelector('.cdiff')?.textContent.includes('target'),'same-chat refresh cleared existing diff');
 await until(()=>!document.querySelector('.changes-toolbar-spinner'));
 // A listed target has the same Session ID before and after open: the original failing case.
 state.workspaces.sessions['C:/fixture']=[{id:'same',path:'same',name:'same'}];
 const same=actions.openSession('same');await wait(40);
 must(state.snap.session.id==='same','fixture did not preserve listed session id');
 await same;await until(()=>document.querySelector('.cfile:not(.sk)')?.textContent.includes('same.ts'));
 await actions.openSession('slow');await until(()=>releaseSlow);
 await actions.openSession('fast');await until(()=>document.querySelector('.cfile:not(.sk)')?.textContent.includes('fast.ts'));
 await until(()=>document.querySelector('.cdiff')?.textContent.includes('fast'));
 releaseSlow();await wait(100);
 must(!document.querySelector('.cdiff')?.textContent.includes('slow'),'late diff crossed chats');
 must(!document.querySelector('.cfile:not(.sk)').textContent.includes('slow.ts'),'late answer crossed chats');
 fail=true;await actions.openSession('bad');await until(()=>document.querySelector('.notice.danger'));
 must(document.querySelector('.notice.danger').textContent.includes('Loading actual diff failed'),'real failure containing Loading was swallowed');
 fail=false;document.querySelector('button[aria-label="Refresh changes"]').click();
 await until(()=>document.querySelector('.cfile:not(.sk)')?.textContent.includes('bad.ts'));
 must(!document.querySelector('.notice.danger'),'manual retry did not clear failure');
 must(calls.some(x=>x.url.includes('fresh=1')&&x.slot==='bad'),'manual refresh lost fresh contract');
 must(calls.filter(x=>x.url.startsWith('/api/changes')).every(x=>x.slot&&!x.slot.startsWith('pending:')),'changes read used implicit/pending slot');
 await realFetch('/api/test/result',{method:'POST',headers:{'content-type':'application/json','x-myharness-web':'1'},body:JSON.stringify({readyMs,calls})});
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack)+'</p>');}
`,
			);
			server.route("POST", "/api/test/result", ({ body }) => {
				if (process.env.MYHARNESS_ARTIFACTS_DIR)
					writeFileSync(
						join(process.env.MYHARNESS_ARTIFACTS_DIR, "tests", "changes-pending-browser.json"),
						JSON.stringify(body, null, 2),
					);
				return { ok: true };
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Changes target readiness",
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
