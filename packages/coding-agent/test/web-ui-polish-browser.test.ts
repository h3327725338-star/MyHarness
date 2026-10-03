import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders migrated image settings, semantic download progress, branch buttons, Git counts and user Markdown",
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
			server.route("GET", "/api/code-intelligence/modules", () => ({
				modules: [{ id: "typescript", label: "TypeScript", languages: ["typescript"], status: "not-installed" }],
				progress: [],
			}));
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
 render(null,app);
 const repairItems=[{kind:'user',id:'task',ts:1,text:'original task',images:[]},{kind:'assistant',ts:2,blocks:[{type:'text',text:'original answer'}],stopReason:'stop',final:true},{kind:'custom',id:'repair',ts:3,customType:'git-commit-repair',display:false},{kind:'assistant',ts:4,blocks:[{type:'toolCall',id:'r',name:'read',args:{path:'repair.ts'}}],stopReason:'toolUse'}];
 set({items:repairItems,gitTask:{active:true,kind:'commit',activity:'Repairing and recommitting'},toolRuns:{r:{status:'running'}},snap:{active:true,cwd:'C:/test',flags:{},session:{id:'test'},thinking:{supported:false},run:{startedAt:Date.now()}}});
 render(h(Transcript,{}),app);await wait(100);
 let card=document.querySelector('.git-result');
 if(document.querySelectorAll('.git-result').length!==1) throw Error('duplicate Commit card');
 if(document.querySelector('.turn:not(.git-result .turn) .summary.live')) throw Error('original task marked as repairing');
 if(!card.textContent.includes('repair.ts')) throw Error('missing live repair activity');
 card.querySelector('[aria-expanded]').click();await wait(100);
 const summary=card.querySelector('.summary-head[aria-expanded]');summary.click();await wait(100);
 if(!card.querySelector('.action')||document.querySelector('.action')?.closest('.git-result')!==card) throw Error('repair tool escaped Commit');
 set({items:[...repairItems,{kind:'toolResult',ts:5,toolCallId:'r',toolName:'read',text:'source',isError:false},{kind:'gitStatus',id:'git',ts:6,result:{tone:'ok',title:'Commit succeeded',hash:'abc1234'}}],gitTask:null,snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'},thinking:{supported:false}}});await wait(100);
 if(document.querySelector('.git-result')!==card||!card.textContent.includes('Commit succeeded')||!card.querySelector('.action')) throw Error('Commit result did not update in place');
 set({items:[...repairItems,{kind:'gitStatus',id:'git',ts:6,result:{tone:'error',title:'Commit failed',detail:'hook failed',lines:'hook failed and diagnostic'}}]});await wait(100);
 if(document.querySelector('.git-result')!==card||card.getAttribute('role')!=='alert'||!card.textContent.includes('hook failed')||document.querySelector('.action')?.closest('.git-result')!==card) throw Error('failed repair escaped Commit');
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
 if(document.querySelector('.settings-nav').textContent.includes('工具调用')) throw Error('empty tools page still in the navigation');
 if([...document.querySelectorAll('.settings-nav button')].filter(b=>b.querySelector('svg')?.innerHTML.startsWith('<path d="M14.7 6.3')).length!==1) throw Error('wrench icon not used exactly once');
 setView({settingsSection:'agent'});await wait(100);
 if(!document.querySelector('.settings-body').textContent.includes('禁止发送图片')||document.querySelector('.set-card-toggle')) throw Error('images not flat in Agent');
 setView({settingsSection:'code'});await wait(150);
 if(!document.querySelector('.settings-nav .on')?.textContent.includes('代码智能')) throw Error('missing code navigation');
 if(!document.querySelector('.settings-body').textContent.includes('Semantic')||!document.querySelector('.settings-body').textContent.includes('TypeScript')||!document.querySelector('.settings-body').textContent.includes('未下载')) throw Error('missing language manager');
 set({codeIntelligenceInstallation:{modules:[{id:'typescript',label:'TypeScript',languages:['typescript'],status:'installing'}],progress:[{id:'typescript',percent:35,remainingSeconds:12}]}});await wait(100);
 if(document.querySelector('progress')?.value!==35||!document.querySelector('.settings-body').textContent.includes('12 秒')) throw Error('download progress not live');
 set({codeIntelligenceInstallation:{progress:[],modules:[
  {id:'java',label:'Java',languages:['java'],serverKey:'jdtls',sharedComponents:['temurin-jre-21'],status:'installed',enabled:true},
  {id:'python',label:'Python',languages:['python'],serverKey:'pyright',sharedComponents:[],status:'unavailable',reason:'release-metadata-missing',message:'Code Intelligence module "python" has no published artifact size; release metadata is not available yet'},
  {id:'swift',label:'Swift',languages:['swift'],serverKey:'sourcekit-lsp',sharedComponents:[],status:'unavailable',reason:'external-prerequisites',notes:'Windows SourceKit-LSP needs the official Swift toolchain and its prerequisites; MyHarness does not download it automatically.',message:'x'}]}});await wait(150);
 {const heads=[...document.querySelectorAll('.lang-head')];
  if(heads.length!==3||document.querySelector('.lang-body')) throw Error('language modules not folded');
  if(!heads[0].textContent.includes('启用')||!heads[1].textContent.includes('暂未发布')) throw Error('folded line lacks name or state: '+heads.map(h=>h.textContent).join('|'));
  heads[0].click();await wait(400);
  const javaBody=document.querySelector('.lang-body').textContent;
  if(!javaBody.includes('语义代码智能')||!javaBody.includes('Java 运行环境')||/[A-Za-z]{4,} (the|and|for) /.test(javaBody.replace(/Java|jdtls|Temurin/g,''))) throw Error('java details not Chinese: '+javaBody);
  if(!document.querySelector('.lang-body .toggle')||document.querySelector('.lang-body .btn')) throw Error('installed module lacks a switch');
  heads[2].click();await wait(400);
  if(!document.querySelector('.lang-item:nth-child(3) .lang-body').textContent.includes('官方 Swift 工具链')) throw Error('swift note not Chinese');
  heads[1].click();await wait(400);
  const download=document.querySelector('.lang-body .btn');
  if(!download||download.disabled) throw Error('download button disabled');
  if(!document.querySelector('.lang-body').textContent.includes('尚未发布')||document.querySelector('.lang-body').textContent.includes('release metadata')) throw Error('metadata note not Chinese');
 }
 checkRows();
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
