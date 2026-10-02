import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders inline settings, tool accordions, branch buttons, coloured Git counts and user Markdown",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-ui-polish-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const items = [
			{
				id: "steeringMode",
				section: "Agent",
				label: "Steering messages",
				type: "enum",
				value: "all",
				options: [{ value: "all", label: "All" }],
			},
			{
				id: "followUpMode",
				section: "Agent",
				label: "Follow-up messages",
				type: "enum",
				value: "all",
				options: [{ value: "all", label: "All" }],
			},
			{ id: "webSearch.enabled", section: "Tools", label: "Web search & fetch", type: "boolean", value: true },
			{
				id: "webSearch.engines",
				section: "Tools",
				label: "Search engines",
				type: "multi",
				value: ["google"],
				options: ["Google", "Bing", "DuckDuckGo", "Brave", "Brave Search API"].map((label) => ({
					value: label.toLowerCase(),
					label,
				})),
			},
			{
				id: "webShutdownGraceSeconds",
				section: "Network",
				label: "Web UI exit delay",
				type: "number",
				value: 10,
				min: 0,
				max: 3600,
				unit: "seconds",
			},
			{ id: "codeIntelligence.enabled", section: "Tools", label: "Code Intelligence", type: "boolean", value: true },
			{ id: "blockImages", section: "Images", label: "Block images", type: "boolean", value: false },
		];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("GET", "/api/settings", () => ({ items }));
			server.route("GET", "/api/stats", () => ({}));
			server.route("GET", "/api/sessions/tree", () => ({
				rows: [
					{
						id: "u",
						kind: "user",
						depth: 6,
						onPath: true,
						isLeaf: false,
						childCount: 1,
						text: "A long message for the branch tree",
					},
				],
			}));
			server.route("GET", "/hold", async () => {
				await new Promise((r) => setTimeout(r, 12000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><link rel="stylesheet" href="/css/panels.css"><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {GitRecord} from '/js/git-record.js';
import {ContextPanel} from '/js/panel-context.js';
import {SettingsModal,sectionOf} from '/js/overlays-settings.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const app=document.getElementById('app');
try {
 document.documentElement.dataset.motion='off';
 setView({lang:'zh-CN',settingsSection:'appearance'});
 const items=${JSON.stringify(items)};
 set({models:[],settings:{items},snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'},thinking:{supported:false}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],items:[{kind:'user',id:'u',ts:1,text:'# Heading\\n\\n- item\\n\\n1. ordered\\n\\n**bold** *italic* \\x60inline\\x60\\n\\n\\x60\\x60\\x60js\\nconst x = 1;\\n\\x60\\x60\\x60\\n\\n<script>bad()</script>',images:[]}]});
 render(h(Transcript,{}),app); await wait(100);
 for(const tag of ['h1','ul','ol','strong','em','pre code']) if(!document.querySelector('.user-text '+tag)) throw Error('user Markdown missing '+tag);
 if(document.querySelector('.user-text script')) throw Error('unsafe HTML');
 render(h(GitRecord,{result:{tone:'ok',title:'Commit succeeded',hash:'abc1234',detail:'Done',lines:'file.ts (+12/-3)\\nplain <tag>'}}),app);
 document.querySelector('[aria-expanded]').click(); await wait(100);
 if(document.querySelector('.strip-lines').textContent!=='file.ts (+12/-3)\\nplain <tag>') throw Error('Git output changed');
 const add=document.querySelector('.strip-lines .add'),del=document.querySelector('.strip-lines .del');
 if(add?.textContent!=='+12'||del?.textContent!=='-3'||getComputedStyle(add).color===getComputedStyle(del).color) throw Error('Git colours');
 render(h(SettingsModal,{}),app); await wait(150);
 if(document.querySelector('.settings-body').textContent.includes('任务运行中')) throw Error('appearance contains scheduling');
 const checkRows=()=>{for(const row of document.querySelectorAll('.set-row')) {
  const text=row.querySelector('.set-text'),control=row.querySelector('.set-control');
  if(control.getBoundingClientRect().left<text.getBoundingClientRect().right-1) throw Error('control overlaps text');
  const desc=row.querySelector('.set-desc');
  if(desc && (desc.scrollWidth>desc.clientWidth+1||getComputedStyle(desc).textOverflow==='ellipsis')) throw Error('description clipped: '+desc.textContent);
 }};
 checkRows();
 for(const section of ['conversation','search','network']) {setView({settingsSection:section});await wait(100);checkRows();}
 if(sectionOf(items[0])!=='conversation'||sectionOf(items[2])!=='search') throw Error('wrong settings ownership');
 setView({settingsSection:'tools'});await wait(100);
 const accordions=[...document.querySelectorAll('.set-card-toggle')];
 if(accordions.length!==2||accordions.some(b=>b.getAttribute('aria-expanded')!=='false')) throw Error('tool accordions missing');
 for(const button of accordions) button.click();await wait(100);checkRows();
 render(null,app);app.style.width='340px';
 set({resources:{tools:[{name:'read',description:'Long English description',active:true}],skills:[],prompts:[],extensions:[],contextFiles:[]},stats:null});
 render(h(ContextPanel,{}),app);await wait(150);
 for(const head of document.querySelectorAll('.ctx-head')) if(head.textContent.includes('分支')||head.textContent.includes('工具')) head.click();await wait(100);
 if(document.querySelector('.tree-node .link-btn')) throw Error('blue branch links');
 for(const button of document.querySelectorAll('.tree-action')) if(getComputedStyle(button).whiteSpace!=='nowrap'||getComputedStyle(button).opacity!=='1') throw Error('branch button hidden or wraps');
 const desc=document.querySelector('.res-desc');
 if(!desc.textContent.includes('读取并解析')||desc.textContent.includes('…')||desc.scrollWidth>desc.clientWidth+1) throw Error('tool localization');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "UI polish test",
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
