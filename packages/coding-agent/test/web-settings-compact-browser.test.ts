import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"applies the compact right-column contract: narrow right-aligned numbers, content-width dropdowns, one shortcut width",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-compact-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const items = [
			{
				id: "contextWindowMain",
				section: "Agent",
				label: "Main context window cap (K tokens)",
				description: "Optional cap for the main session. Empty uses the model's window.",
				type: "tokens",
				value: 262144,
				unit: "K",
				unitSize: 1024,
			},
			{
				id: "contextWindowSubAgent",
				section: "Agent",
				label: "Sub-agent context window cap (K tokens)",
				description: "Optional cap for sub-agents. Empty uses the model's window.",
				type: "tokens",
				value: null,
				unit: "K",
				unitSize: 1024,
			},
			{
				id: "subAgent",
				section: "Assistants",
				label: "Sub-agents (Explore)",
				description: "Allow the agent to delegate read-only investigation to sub-agents.",
				type: "modelRef",
				value: { enabled: true, maxTasks: 3, mode: "read-only" },
				note: "enabled",
				modeSelect: {
					options: [
						{ value: "read-only", label: "Read only" },
						{ value: "read-write", label: "Read & write" },
					],
				},
				inlineNumber: { min: 1, max: 18 },
			},
			{
				id: "webSearch.pagesPerSearch",
				section: "Web search",
				label: "Pages read per search",
				type: "number",
				value: 5,
				min: 0,
				max: 10,
			},
			{
				id: "webSearch.maxUrlsPerFetch",
				section: "Web search",
				label: "Max URLs per fetch",
				type: "number",
				value: 8,
				min: 1,
				max: 20,
			},
			{
				id: "webSearch.fetchConcurrency",
				section: "Web search",
				label: "Concurrent downloads",
				type: "number",
				value: 4,
				min: 1,
				max: 8,
			},
			{
				id: "webSearch.maxRedirects",
				section: "Web search",
				label: "Max redirects",
				type: "number",
				value: 5,
				min: 0,
				max: 20,
			},
			{
				id: "transport",
				section: "Network",
				label: "Provider transport",
				type: "enum",
				value: "auto",
				options: [
					{ value: "auto", label: "Auto" },
					{ value: "sse", label: "SSE" },
					{ value: "websocket", label: "WebSocket" },
					{ value: "websocket-cached", label: "WebSocket (cached)" },
				],
			},
		];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/settings", () => ({ items }));
			// Empty provider lists, so the Providers page renders its real layout in the overflow/containment sweep below.
			server.route("GET", "/api/providers", () => ({ providers: [] }));
			server.route("GET", "/api/providers/custom", () => ({ providers: [] }));
			server.route("GET", "/hold", async () => {
				await new Promise((r) => setTimeout(r, 12000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const app=document.getElementById('app');
const rect=el=>el.getBoundingClientRect();
const optionTextW=async(trigger)=>{const cs=getComputedStyle(trigger);const c=document.createElement('canvas').getContext('2d');c.font=(cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily).replace(/\\s+/g,' ').trim();trigger.click();await wait(350);const options=[...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')];let longest=0;for(const o of options)longest=Math.max(longest,c.measureText(o.textContent.trim()).width);trigger.click();await wait(250);return {longest,options};};
const rowWith=needle=>{const rows=[...document.querySelectorAll('.set-row')];const r=rows.find(r=>r.querySelector('.set-label')?.textContent.includes(needle));if(!r)throw Error('missing row: '+needle);return r;};
const right=el=>Math.round(rect(el).right);
const rightsEqual=(els,what)=>{const rs=els.map(right);if(new Set(rs).size>1)throw Error(what+' right edges differ: '+rs);};
const widthsEqual=(els,what)=>{const ws=els.map(e=>Math.round(rect(e).width));if(new Set(ws).size>1)throw Error(what+' widths differ: '+ws);};
const numWidth=el=>{const w=rect(el).width;if(w<76||w>84)throw Error('number box not 76-84px: '+Math.round(w)+' ('+(el.getAttribute('aria-label')||el.className)+')');};
const runChecks=async()=>{
 setView({settingsSection:'agent'});await wait(150);
 const capRows=[...document.querySelectorAll('.set-row')].filter(r=>r.querySelector('.set-label')?.textContent.includes('K tokens'));
 if(capRows.length!==2)throw Error('expected two (K tokens) cap rows, got '+capRows.length);
 for(const r of capRows){
  if(r.querySelector('.group-unit'))throw Error('unit box still on a context window row');
  if(r.querySelector('.tokens-exact'))throw Error('token count note still on a context window row');
  const i=r.querySelector('input.field.num');if(!i)throw Error('no narrow number box on a context window row');numWidth(i);
 }
 rightsEqual(capRows.map(r=>r.querySelector('input.field.num')),'context window caps');
 const main=capRows[0].querySelector('input.field.num');
 if(main.value!=='256')throw Error('262144 tokens must show as 256 (K=1024): '+main.value);
 const sub=rowWith('Explore');
 if(sub.querySelector('span.group-unit'))throw Error('1–18 unit box still on the sub-agent row');
 const desc=sub.querySelector('.set-desc');
 if(!desc.textContent.includes('1–18'))throw Error('sub-agent range missing from its description: '+desc.textContent);
 if(desc.scrollWidth>desc.clientWidth+1)throw Error('sub-agent description clipped: '+desc.textContent);
 numWidth(sub.querySelector('input.field.num'));
 const mode=sub.querySelector('.select-like.mref-mode');if(!mode)throw Error('sub-agent mode select missing');
 {const w=rect(mode).width;const measured=await optionTextW(mode);if(w>measured.longest+60)throw Error('mode select wider than its options plus 60: '+Math.round(w)+'>'+Math.round(measured.longest));}
 setView({settingsSection:'search'});await wait(150);
 const snums=[...document.querySelectorAll('.set-row input.field.num')];
 if(snums.length!==4)throw Error('expected four search number rows, got '+snums.length);
 for(const i of snums)numWidth(i);
 rightsEqual(snums,'search numbers');
 setView({settingsSection:'network'});await wait(150);
 const transportRow=[...document.querySelectorAll('.set-row')].find(r=>/transport/i.test(r.querySelector('.set-label')?.textContent||'')||/传输/.test(r.querySelector('.set-label')?.textContent||''));
 if(!transportRow)throw Error('missing row: transport');
 const sel=transportRow?.querySelector('.set-control > .select-like');
 if(!sel)throw Error('transport select missing');
 {const w=rect(sel).width;const col=rect(sel.closest('.set-control')).width;const measured=await optionTextW(sel);
  if(!measured.options.some(o=>/cached|缓存/.test(o.textContent)))throw Error('transport select lost its cached option');
  if(w>measured.longest+60)throw Error('transport select wider than content+60: '+Math.round(w));
  if(w>=col-1)throw Error('transport select still fills the column: '+Math.round(w));
  if(sel.scrollWidth>sel.clientWidth+1)throw Error('transport select clipped: '+sel.textContent.trim());}
 setView({settingsSection:'shortcuts'});await wait(150);
	 const si=[...document.querySelectorAll('[data-shortcut-editor]')];
	 if(si.length!==6)throw Error('shortcut editors not six: '+si.length);
	 widthsEqual(si,'shortcut editors');rightsEqual(si,'shortcut editors');
	 const sw=rect(si[0]).width;if(sw<110||sw>160)throw Error('shortcut editor width outside 110-160: '+Math.round(sw));
	 const overflowPages=['appearance','agent','search','network','shortcuts','providers'];
	 for(const p of overflowPages){
	  setView({settingsSection:p});await wait(250);
	  const body=document.querySelector('.settings-body');if(!body)throw Error('settings body missing on '+p);
	  if(body.scrollWidth>body.clientWidth+1)throw Error('horizontal overflow in settings-body on '+p);
	  for(const c of document.querySelectorAll('.set-card')){
	   if(c.scrollWidth>c.clientWidth+1)throw Error('horizontal overflow in a card on '+p);
	   const cr=rect(c);
	   for(const el of c.querySelectorAll('input,select,button,.toggle,.set-multiselect')){
	    const er=rect(el);if(er.width===0&&er.height===0)continue;
	    if(er.right>cr.right+0.6||er.left<cr.left-0.6)throw Error('control outside card on '+p+': '+el.tagName+' '+el.className);
	   }
	  }
	 }
	 setView({settingsSection:'agent'});
};
try {
 document.documentElement.dataset.motion='off';
 set({models:[],settings:{items:${JSON.stringify(items)}},snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'},thinking:{supported:false}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],items:[]});
 render(h(SettingsModal,{}),app);await wait(150);
 for(const lang of ['en','zh-CN']){setView({lang,settingsSection:'agent'});await wait(200);await runChecks();}
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Settings compact test",
				isSolved: (p) => p.text.includes('id="ready">'),
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
