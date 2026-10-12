// Browser lock for the compacted tool cards: on a real page, inject tool calls, expand the card and
// measure with getComputedStyle / getBoundingClientRect — flat sections, one scroll viewport, a tight
// arguments-to-result gap — plus the friendly note that replaces the raw truncation marker fields.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders expanded tool cards flat, compact and with a friendly truncation note",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-card-compact-browser-"));
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
const snap={active:true,cwd:'C:/test',flags:{},session:{id:'compact'},run:{startedAt:Date.now()}};
const items=[
 {kind:'user',id:'u1',ts:1,text:'run a command',images:[]},
 {kind:'assistant',id:'a1',ts:2,model:'test',blocks:[
  {type:'toolCall',id:'c1',name:'bash',args:{command:'ls -la'}},
  {type:'toolCall',id:'c2',name:'custom_fetcher',args:{url:'https://example.com/big.json'}}]},
 {kind:'toolResult',id:'r1',toolCallId:'c1',text:'total 3\\ndrwxr-xr-x',isError:false,details:{exitCode:0,durationMs:12},ts:3},
 {kind:'toolResult',id:'r2',toolCallId:'c2',text:'ok',isError:false,details:{truncatedDetails:true,originalChars:412345},ts:4}];
try {
 setView({processDefault:'expanded'});
 set({items,snap,dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],models:[]});
 render(h(Transcript,{}),document.getElementById('app')); await wait(450);
 if(document.querySelector('.summary-head')?.getAttribute('aria-expanded')!=='true') throw Error('summary not expanded');
 const rows=[...document.querySelectorAll('.action-row')];
 if(rows.length!==2) throw Error('expected 2 action rows, got '+rows.length);
 rows[0].click(); await wait(450);
 const raw=document.querySelectorAll('.raw')[0];
 if(!raw) throw Error('expanded card missing');
 const body=raw.querySelector('.raw-body');
 if(!body) throw Error('.raw-body missing');
 if(getComputedStyle(body).overflowY!=='auto') throw Error('.raw-body is not the scroll viewport');
 const secs=[...raw.querySelectorAll('.raw-section')];
 if(secs.length!==2) throw Error('expected 2 raw sections, got '+secs.length);
 for(const s of secs){
  const cs=getComputedStyle(s);
  if(cs.backgroundColor!=='rgba(0, 0, 0, 0)') throw Error('section background not transparent: '+cs.backgroundColor);
  if(cs.borderTopWidth!=='0px'||cs.borderBottomWidth!=='0px'||cs.borderLeftWidth!=='0px'||cs.borderRightWidth!=='0px') throw Error('section still framed');
 }
 const argsPre=secs[0].querySelector('pre.raw-pre');
 const resSec=secs[1];
 const resLabel=resSec.querySelector('.raw-label');
 const resPre=resSec.querySelector('pre.raw-pre');
 if(!argsPre||!resLabel||!resPre) throw Error('args pre, result label or result pre missing');
 const gap=resPre.getBoundingClientRect().top-argsPre.getBoundingClientRect().bottom;
 const white=gap-resLabel.getBoundingClientRect().height;
 if(white>15) throw Error('arguments-to-result vertical gap is '+white.toFixed(1)+'px (limit 15)');
 for(const p of [argsPre,resPre]){
  const cs=getComputedStyle(p);
  if(cs.overflowY==='auto'||cs.overflowY==='scroll') throw Error('nested scroller on pre');
  if(p.scrollHeight>p.clientHeight+1) throw Error('pre scrolls internally');
 }
 // Truncation marker renders as a friendly note in both languages, never as the raw fields.
 setView({lang:'zh-CN'}); await wait(80);
 render(null,document.getElementById('app')); render(h(Transcript,{}),document.getElementById('app')); await wait(450);
 document.querySelectorAll('.action-row')[1].click(); await wait(450);
 if(!document.querySelector('.raw-note')) throw Error('zh: .raw-note missing');
 let txt=document.getElementById('app').textContent;
 if(!txt.includes('\\u7ed3\\u679c\\u8be6\\u60c5\\u8fc7\\u5927\\uff08412,345 \\u4e2a\\u5b57\\u7b26\\uff09')) throw Error('zh: friendly note text missing: '+txt.slice(txt.indexOf('\\u7ed3\\u679c\\u8be6\\u60c5'),120));
 if(txt.includes('truncatedDetails')||txt.includes('originalChars')) throw Error('zh: raw marker fields still shown');
 setView({lang:'en'}); await wait(80);
 render(null,document.getElementById('app')); render(h(Transcript,{}),document.getElementById('app')); await wait(450);
 document.querySelectorAll('.action-row')[1].click(); await wait(450);
 txt=document.getElementById('app').textContent;
 if(!txt.includes('Result details are too large to show (412,345 characters)')) throw Error('en: friendly note text missing');
 if(txt.includes('truncatedDetails')||txt.includes('originalChars')) throw Error('en: raw marker fields still shown');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Tool card compact",
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
