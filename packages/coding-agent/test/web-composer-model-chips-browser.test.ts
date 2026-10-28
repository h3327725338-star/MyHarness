import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The model and thinking-effort chips of the composer bar (composer.js ModelPicker / MainEffortPicker, composer.css
// .chip, @container composer-bar): however narrow the chat column, they show the model name and the effort level, never
// only their chevrons. Short of room the model name ends in an ellipsis while the effort level stays whole; in a very
// narrow bar the chevrons step aside; nothing pushes the send button out of the card. The expanded editor of a narrow
// column is wide, so there the chips are whole again.
const chipsJs = `
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {set,setView} from '/js/store.js';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const frame=document.getElementById('frame');
const log=[];
// The chat column with the data-w the app gives it (app.js useWidthClass: under 430px "xs", under 620px "s").
const sizeTo=async(w)=>{frame.style.width=w+'px';frame.dataset.w=w<430?'xs':w<620?'s':'m';await wait(150);};
const look=(scope)=>{
 const bar=document.querySelector(scope+' .composer-bar');
 const card=bar.closest('.composer').getBoundingClientRect();
 const send=bar.querySelector('.send').getBoundingClientRect();
 const chips=[...bar.querySelectorAll('.chip')].map((chip)=>{
  const text=chip.querySelector('.chip-text');
  return {text:text.textContent,shown:getComputedStyle(text).display!=='none',w:text.clientWidth,whole:text.scrollWidth<=text.clientWidth,chev:getComputedStyle(chip.querySelector('.chev')).display!=='none'};
 });
 const out={bar:Math.round(bar.getBoundingClientRect().width),inside:send.right<=card.right+0.5,chips};
 log.push(out);
 return out;
};
try {
 set({items:[],snap:{cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id:'chips',file:'C:/fixture/chips.jsonl'},
   model:{id:'claude-opus-5-5',name:'Claude Opus 5.5',provider:'p',input:['text']},
   thinking:{supported:true,level:'medium',levels:['low','medium','high','xhigh','max']},
   context:{budget:{activeTokens:120,effectiveWindow:8000,percent:2}},run:{},queue:{},app:{}},
  surface:{widgets:{},statuses:{}},queue:{steering:[],followUp:[]},dialogs:[],resources:{commands:[],tools:[],skills:[],templates:[],extensions:[]}});
 setView({lang:'en'});
 render(h(Composer,{}),frame);
 await wait(300);
 for(const w of [760,520,420,380,340,320]){
  await sizeTo(w);
  const {bar,inside,chips:[model,effort]}=look('#frame');
  check(model&&effort,w+'px: expected the model and the effort chip');
  check(model.text==='Claude Opus 5.5'&&effort.text==='medium','wrong chip texts: '+model.text+' / '+effort.text);
  check(model.shown&&effort.shown,w+'px: a chip shows only its chevron');
  check(effort.whole,w+'px: the effort level is cut');
  check(model.w>=48,w+'px: the model name keeps only '+model.w+'px');
  check(inside,w+'px: the send button is pushed out of the card');
  // Where the column has room, everything is whole, chevrons included (the desktop app's narrowest column is ~410px).
  if(w>=420) check(model.whole&&model.chev&&effort.chev,w+'px: the chips are not whole although they fit');
  if(bar<=300) check(!model.chev&&!effort.chev,w+'px: a very narrow bar ('+bar+'px) still spends room on chevrons');
 }
 // The expanded editor of a narrow column is wide: the chips are whole again.
 set({editorInsert:{text:'1\\n2\\n3\\n4\\n5',replace:true,nonce:1}});
 await wait(250);
 document.querySelector('.composer-expand').click();
 await wait(400);
 const {chips:[model,effort]}=look('.composer.expanded');
 check(model.whole&&model.chev&&effort.whole&&effort.chev,'the expanded editor of a narrow column does not show the chips whole');
 const done=document.createElement('p');done.id='ready';done.textContent='passed';
 document.body.append(done);
} catch(error) { const fail=document.createElement('p');fail.id='ready';fail.textContent='FAILED '+error.message+' '+JSON.stringify(log);document.body.append(fail); }
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"composer model and effort chips keep their text in a narrow chat column",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-composer-chips-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				contextFiles: [],
				tools: [],
				skills: [],
				templates: [],
				extensions: [],
			}));
			server.route("GET", "/api/models", () => ({ providers: [] }));
			server.route("POST", "/api/modes/state", () => ({
				state: { lastSessionFile: null, model: null, drafts: {} },
			}));
			writeFileSync(join(root, "test.js"), chipsJs);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/composer.css"><div style="height:420px"></div><div id="frame" class="main" style="height:420px;justify-content:flex-end"></div><script type="module" src="/test/test.js"></script>',
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Composer model chips test",
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
