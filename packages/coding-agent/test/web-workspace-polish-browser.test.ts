import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"animates folder and draft presence, edits aliases and labels model prices in currency units",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-polish-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/files/list", ({ url }) => ({
				entries: url.searchParams.get("dir")
					? [{ type: "file", path: "folder/file.ts", name: "file.ts" }]
					: [{ type: "dir", path: "folder", name: "folder" }],
			}));
			server.route("GET", "/api/changes", () => ({ files: [] }));
			server.route("GET", "/api/git/branches", async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return { branches: [{ name: "main", current: true, committedAt: 1 }] };
			});
			server.route("GET", "/api/git/worktrees", async () => {
				await new Promise((resolve) => setTimeout(resolve, 800));
				return { worktrees: [{ path: "C:/project", isMain: true, current: true }] };
			});
			server.route("POST", "/api/files/upload", () => ({ name: "notes.txt", path: "C:/session/uploads/notes.txt" }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {FilesPanel} from '/js/panel-files.js';
import {Sidebar} from '/js/sidebar.js';
import {BranchChip} from '/js/branch-menu.js';
import {Composer} from '/js/composer.js';
import {ProviderForm} from '/js/provider-form.js';
import {set,setView,state} from '/js/store.js';
import {actions} from '/js/actions.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
try {
 setView({motion:'on',lang:'zh-CN'}); setLang('zh-CN');
 set({snap:{session:{id:'test'},flags:{}},slots:[]});
 render(h(FilesPanel,{}),document.getElementById('app')); await wait(400);
 document.querySelector('.tree-row').click(); await wait(600);
 check(document.querySelector('[role=group]').textContent.includes('file.ts'),'folder not expanded');
 check(getComputedStyle(document.querySelector('.fold-chevron')).transform!=='none','arrow not rotated');
 document.querySelector('.tree-row').click(); await wait(30);
 check(document.querySelector('[role=group]'),'exit removed instantly');
 await wait(450); check(!document.querySelector('[role=group]'),'folder exit did not finish');
 render(null,document.getElementById('app'));
 const info={path:'draft',empty:true};
 const ws={list:[{id:'w',name:'Original',rootPath:'C:/project'}],sessions:{'C:/project':[{path:'history',name:'History'}]},unbound:[],errors:{}};
 setView({expanded:{'C:/project':true}});
 set({workspaces:ws,activeSlot:'draft-slot',slots:[{slot:'draft-slot',cwd:'C:/project',sessionFile:'draft',sessionId:'draft-id'}],snap:{session:{file:'draft'},workspace:{id:'w',rootPath:'C:/project'}}});
 let renamed;
 actions.renameWorkspace=async(id,name)=>{renamed={id,name};set({workspaces:{...state.workspaces,list:[{...ws.list[0],name}]}});return {ok:true}};
 render(h(Sidebar,{}),document.getElementById('app')); await wait(550);
 check(document.querySelector('.chat-row').textContent.includes('新对话'),'draft not first');
 set({slots:[{slot:'new-slot',cwd:'C:/project',sessionFile:'new-draft',sessionId:'new-id'}],activeSlot:'new-slot',snap:{session:{file:'new-draft'},workspace:{id:'w',rootPath:'C:/project'}}});await wait(70);
 check(document.querySelector('.chat-row').textContent.includes('新对话'),'new draft inserted below history');
 check(document.querySelectorAll('.chat-row').length===3,'exit not retained during insertion');
 await wait(450);check(document.querySelectorAll('.chat-row').length===2,'old draft retained too long');
 set({activeSlot:'other',slots:[]}); await wait(60);
 check(document.querySelector('.chat-row'),'draft removed instantly');
 await wait(600);check(document.querySelectorAll('.chat-row').length===1,'draft not cleaned up');
 document.querySelector('[aria-label="Workspace 操作"]').click(); await wait(100);
 const rename=[...document.querySelectorAll('.menu-item')].find(el=>el.textContent.includes('重命名'));
 check(rename,'rename menu missing');rename.click();await wait(100);
 let input=document.querySelector('.ws-row input');check(input,'alias input missing');
 input.value='Cancelled'; input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(100);check(!renamed,'Esc saved alias');
 document.querySelector('[aria-label="Workspace 操作"]').click();await wait(80);[...document.querySelectorAll('.menu-item')].find(el=>el.textContent.includes('重命名')).click();await wait(80);
 input=document.querySelector('.ws-row input');input.value='Friendly';input.dispatchEvent(new Event('input',{bubbles:true}));await wait(30);input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await wait(200);
 check(renamed?.name==='Friendly'&&state.workspaces.list[0].rootPath==='C:/project','alias changed path or not saved');
 render(null,document.getElementById('app'));
 render(h(BranchChip,{gitStatus:{branch:'main'}}),document.getElementById('app'));await wait(50);
 document.querySelector('.branch-chip').click();await wait(150);
 let pop=document.querySelector('.branch-pop');check(pop&&!pop.classList.contains('leaving'),'branch entered with exit animation');
 const before=pop.getBoundingClientRect();await wait(1000);const after=pop.getBoundingClientRect();
 check(Math.abs(before.height-after.height)<1&&Math.abs(before.top-after.top)<3,'async lists shifted popover');
 check(pop.textContent.includes('main'),'branches missing');
 document.querySelector('.branch-chip').click();await wait(240);check(!document.querySelector('.branch-pop'),'popover exit retained');
 render(null,document.getElementById('app'));
 set({snap:{session:{id:'import'},flags:{},trust:{trusted:true},model:{id:'m',input:['text','image']}},gitStatus:null,resources:{commands:[]},items:[],dialogs:[],queue:{steering:[],followUp:[]},surface:{widgets:{},statuses:{}}});
 render(h(Composer,{}),document.getElementById('app'));await wait(200);
 const dt=new DataTransfer();dt.items.add(new File(['hello'],'notes.txt',{type:'text/plain'}));
 document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));await wait(350);
 check(document.querySelector('.file-attachment')?.textContent.includes('notes.txt'),'viewport file drop ignored');
 check(!document.querySelector('input[type=file]').hasAttribute('accept'),'picker restricts files');
 let sent;actions.submit=async(text,options)=>{sent={text,options};return {handled:false,ok:true}};
 document.querySelector('.send').click();await wait(120);
 check(sent?.text.includes('C:/session/uploads/notes.txt')&&sent.options.images.length===0,'file reference not sent');
 const editorDrop=new DataTransfer();editorDrop.items.add(new File(['again'],'notes.txt',{type:'text/plain'}));
 document.querySelector('.composer-input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:editorDrop}));await wait(250);
 check(document.querySelectorAll('.file-attachment').length===1,'editor drop ignored or duplicated');
 document.querySelector('[aria-label="附加或插入"]').click();await wait(100);
 check([...document.querySelectorAll('.menu-item')].some(el=>el.textContent.includes('Explorer')),'Explorer entry missing');
 const chooser=document.querySelector('input[type=file]');let pickerOpened=false;chooser.click=()=>{pickerOpened=true};
 [...document.querySelectorAll('.menu-item')].find(el=>el.textContent.includes('Explorer')).click();await wait(80);
 check(pickerOpened&&chooser.accept==='','file menu did not invoke unrestricted picker');
 chooser.files=dt.files;chooser.dispatchEvent(new Event('change',{bubbles:true}));await wait(250);
 check(document.querySelectorAll('.file-attachment').length===2,'selected file not loaded');
 render(null,document.getElementById('app'));
 render(h(ProviderForm,{initial:{id:'test',config:{api:'openai-completions',baseUrl:'https://example.invalid',models:[{id:'model',name:'Model',pricing:{currency:'USD',input:1,output:2,cacheRead:0.1,cacheWrite:0.2,tiers:[]}}]}}}),document.getElementById('app'));await wait(100);
 document.querySelector('.pf-model-toggle').click();await wait(400);
 document.querySelector('.pf-pricing .toggle').click();await wait(100);
 check(document.querySelector('.pf-pricing').textContent.includes('($/1M)'),'USD unit missing');
 const currency=document.querySelector('.pf-pricing select');currency.value='CNY';currency.dispatchEvent(new Event('change',{bubbles:true}));await wait(100);
 check(document.querySelector('.pf-pricing').textContent.includes('(¥/1M)'),'CNY unit not updated');
 const add=[...document.querySelectorAll('.pf-pricing button')].find(el=>el.textContent.includes('添加计价阶梯'));check(add&&!add.classList.contains('ghost')&&add.querySelector('svg'),'tier button missing');add.click();await wait(100);
 check(document.querySelectorAll('.pf-pricing input[type=number]').length===9,'tier fields missing');
 const kv=document.createElement('div');kv.className='kv';kv.style.width='280px';kv.innerHTML='<span>运行过 Shell 命令</span><span>yes</span>';document.body.append(kv);check(getComputedStyle(kv.firstChild).whiteSpace==='nowrap','checkpoint label wraps');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Workspace polish",
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
