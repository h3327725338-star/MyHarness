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
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-polish-browser-"));
		const server = new WebHttpServer();
		let branchRequests = 0;
		let worktreeRequests = 0;
		let copyDeleteRequests = 0;
		let copyDeleteForceRequests = 0;
		let copyDeleted = false;
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
				branchRequests++;
				await new Promise((resolve) => setTimeout(resolve, 500));
				return { branches: [{ name: "main", current: true, committedAt: 1 }] };
			});
			server.route("GET", "/api/git/worktrees", async () => {
				worktreeRequests++;
				await new Promise((resolve) => setTimeout(resolve, 800));
				return {
					worktrees: [
						{ path: "C:/project", branch: "main", isMain: true, current: true },
						...(copyDeleted ? [] : [{ path: "C:/copies/task-fix", branch: "task-fix", changes: 0, ahead: 0 }]),
						{ path: "C:/copies/detached", current: true },
					],
				};
			});
			server.route("GET", "/api/test/request-counts", () => ({
				branchRequests,
				worktreeRequests,
				copyDeleteRequests,
				copyDeleteForceRequests,
			}));
			server.route("POST", "/api/git/worktrees/delete", ({ body }) => {
				const payload = body as { path?: unknown; force?: unknown };
				expect(payload).toMatchObject({ path: "C:/copies/task-fix" });
				if (payload.force === true) copyDeleteForceRequests++;
				copyDeleteRequests++;
				if (copyDeleteRequests === 1)
					throw new Error(
						"删除 Worktree 失败：git worktree remove failed: fatal: 'C:/copies/task-fix' contains modified or untracked files, use --force to delete it",
					);
				copyDeleted = true;
				return { ok: true };
			});
			server.route("POST", "/api/files/upload", () => ({ name: "notes.txt", path: "C:/session/uploads/notes.txt" }));
			// The composer sends a file that is not an inline image in chunks.
			server.route("POST", "/api/files/upload/begin", () => ({ uploadId: "upload-1" }));
			server.route("POST", "/api/files/upload/chunk", () => ({ written: 5 }));
			server.route("POST", "/api/files/upload/finish", () => ({
				name: "notes.txt",
				path: "C:/session/uploads/notes.txt",
			}));
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
import {ContextDetails} from '/js/context-usage.js';
import {ProviderForm} from '/js/provider-form.js';
import {activateSlot,set,setView,state} from '/js/store.js';
import {actions} from '/js/actions.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await wait(50)}throw Error('timed out waiting for UI: '+String(fn).slice(0,160))};
const pickSelect=async(triggerSelector,optionText)=>{const trigger=document.querySelector(triggerSelector);check(trigger,'select trigger missing: '+triggerSelector);trigger.click();await until(()=>document.querySelector('.popover.select-pop:not(.closing) [role=option]'));const options=[...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')];const hit=options.find(el=>el.textContent.includes(optionText));check(hit,'select option missing: '+optionText);hit.click();await wait(120);};
try {
 setView({motion:'on',lang:'zh-CN'}); setLang('zh-CN');
 // Send 只在页面已连上服务端事件流时可用；本测试直接渲染组件而不连事件流，所以要手动进入 connected 态。
 set({connected:true});
 set({snap:{session:{id:'test'},flags:{},context:{budget:{activeTokens:250,effectiveWindow:1000,percent:25}}},slots:[]});
 render(h(ContextDetails,{}),document.getElementById('app')); await wait(30);
 check(document.querySelector('.cu-top').textContent.includes('25%')&&!document.querySelector('.empty'),'context opens without data or shows loading');
 set({snap:{session:{id:'test2'},flags:{},context:{budget:{activeTokens:0,effectiveWindow:2000,percent:0}}}}); await wait(30);
 check(document.querySelector('.cu-top').textContent.includes('0%')&&document.querySelector('.cu-sub strong').textContent==='0','context retains old Chat or loses zero');
 render(null,document.getElementById('app'));
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
 // The left draft waits for the new one to grow in (260 ms), then folds away (260 ms + 60 ms).
 await wait(600);check(document.querySelectorAll('.chat-row').length===2,'old draft retained too long');
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
 document.getElementById('app').style.cssText='position:fixed;bottom:20px;left:20px';
 render(h(BranchChip,{gitStatus:{branch:'main'}}),document.getElementById('app'));await wait(50);
 document.querySelector('.branch-chip').click();await wait(150);
 let pop=document.querySelector('.branch-pop');check(pop&&!pop.classList.contains('leaving'),'branch entered with exit animation');
 check(!document.querySelector('.branch-new.hi'),'new branch highlighted while loading');
 const initialCounts=await (await fetch('/api/test/request-counts')).json();
 check(initialCounts.branchRequests===1&&initialCounts.worktreeRequests<=1,'prefetch duplicated: '+JSON.stringify(initialCounts));
 const search=document.querySelector('.pop-search input');
 search.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await wait(30);
 check(!document.querySelector('.branch-foot form'),'Enter creates branch while loading');
 await until(()=>document.querySelector('.branch-name')?.textContent==='main');
 await wait(400);pop=document.querySelector('.branch-pop');
 check(pop.textContent.includes('main'),'branches missing');
 const listRowsHeight=()=>[...document.querySelector('.branch-list').children].reduce((n,el)=>n+el.offsetHeight,0);
 check(Math.abs(document.querySelector('.branch-list').offsetHeight-listRowsHeight())<2,'the list reserves empty space');
 const anchor=document.querySelector('.branch-chip').getBoundingClientRect();
 const anchored=()=>Math.abs(pop.getBoundingClientRect().bottom-anchor.top+6)<3||Math.abs(pop.getBoundingClientRect().top-8)<3;
 check(anchored(),'compact popover lost anchor');
 // Copies share the list with the branches; the two actions sit side by side in the footer.
 const taskFix=()=>document.querySelector('.branch-row[data-copy-path="C:/copies/task-fix"]');
 await until(()=>taskFix());await wait(300);
 check(anchored(),'popover lost its anchor once the copies arrived');
 check(document.querySelector('.branch-foot .branch-new')&&document.querySelector('.branch-foot .branch-wt-action')?.textContent.includes('创建并进入副本'),'the footer does not hold both actions');
 check(document.querySelector('.branch-row').textContent.includes('主副本'),'main copy is not first');
 const copyInfo=taskFix().querySelector('.branch-info');
 check(copyInfo.children.length===2&&copyInfo.children[1].getBoundingClientRect().top>copyInfo.children[0].getBoundingClientRect().top,'copy name and path not stacked');
 const copyDeletes=()=>[...document.querySelectorAll('.branch-list [aria-label="删除副本"]')];
 check(copyDeletes().length===1,'the main copy or the copy in use offers deletion');
 set({snap:{...state.snap,active:true}});await wait(60);check(copyDeletes().every(button=>button.disabled),'running task permits copy deletion');
 set({snap:{...state.snap,active:false}});await wait(60);
 const ask=()=>document.querySelector('[aria-label="删除副本？"]');
 const counts=async()=>(await fetch('/api/test/request-counts')).json();
 copyDeletes()[0].click();await until(()=>ask()?.textContent.includes('不会丢'));
 check((await counts()).copyDeleteRequests===0,'opening the question deletes');
 [...ask().querySelectorAll('button')].find(b=>b.textContent==='删除').click();
 for(let i=0;i<100;i++){if((await counts()).copyDeleteRequests===1)break;await wait(50)}
 await until(()=>ask()?.querySelector('[role="alert"]')&&![...ask().querySelectorAll('button')].some(b=>b.disabled));
 check(taskFix()&&document.body.textContent.includes('安全删除被拒绝'),'failed deletion removes the copy or shows no plain-language explanation');
 const forceButton=[...ask().querySelectorAll('button')].find(b=>b.textContent==='强制删除副本');
 check(forceButton?.classList.contains('solid')&&ask().querySelectorAll('.danger.solid').length===1,'failed copy deletion does not offer a single force button');
 forceButton.click();await until(()=>!taskFix()&&!ask());
 check((await counts()).copyDeleteForceRequests===1,'force copy delete did not send force flag');
 check(document.querySelectorAll('.branch-row')[1]?.textContent.includes('detached'),'successful deletion not refreshed');
 document.querySelector('.branch-chip').click();await wait(240);check(!document.querySelector('.branch-pop'),'popover exit retained');
 document.querySelector('.branch-chip').click();await wait(60);
 check(document.querySelector('.branch-name')?.textContent==='main'&&!document.querySelector('.branch-new.hi'),'cached branches not immediately available');
 check(document.querySelector('.branch-row.hi.active'),'current branch not selected');
 document.querySelector('.branch-chip').click();await wait(240);
 render(null,document.getElementById('app'));
 render(h(BranchChip,{gitStatus:{branch:'task-fix',linkedWorktree:true}}),document.getElementById('app'));await wait(60);
 document.querySelector('.branch-chip').click();await until(()=>document.querySelector('.branch-name')&&document.querySelector('.branch-wt-action')?.textContent.includes('返回主副本'));
 check(document.querySelector('.branch-chip .wt-tag'),'linked copy not labelled');
 render(null,document.getElementById('app'));
 document.getElementById('app').style.cssText='';
 if (${process.env.MYHARNESS_BRANCH_MENU_ONLY !== "1"}) {
 // Sends go to a loaded chat only: open one, its snapshot and (empty) transcript answered here.
 const serverFetch=window.fetch.bind(window);
 window.fetch=async(url,init)=>{const u=String(url);
  if(u==='/api/state') return new Response(JSON.stringify({slot:'import',mode:'coding',session:{id:'import',persisted:true},flags:{},trust:{trusted:true},model:{id:'m',input:['text','image']},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}},thinking:{levels:[]},run:{},app:{}}),{headers:{'content-type':'application/json'}});
  if(u.startsWith('/api/transcript')) return new Response(JSON.stringify({items:[]}),{headers:{'content-type':'application/json'}});
  return serverFetch(url,init);};
 await activateSlot('import');
 set({connected:true,snap:{session:{id:'import',persisted:true},flags:{},trust:{trusted:true},model:{id:'m',input:['text','image']}},gitStatus:null,resources:{commands:[]},items:[],dialogs:[],queue:{steering:[],followUp:[]},surface:{widgets:{},statuses:{}}});
 render(h(Composer,{}),document.getElementById('app'));await wait(200);
 const dt=new DataTransfer();dt.items.add(new File(['hello'],'notes.txt',{type:'text/plain'}));
 document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));await wait(350);
 check(document.querySelector('.file-attachment')?.textContent.includes('notes.txt'),'viewport file drop ignored');
 check(!document.querySelector('input[type=file]').hasAttribute('accept'),'picker restricts files');
 let sent;actions.submit=async(text,options)=>{sent={text,options};return {handled:false,ok:true}};
 document.querySelector('.send').click();await wait(120);
 // A file goes as an attachment record (its stored path), not as text in the message.
 check(sent?.options.attachments?.some(a=>a.path==='C:/session/uploads/notes.txt')&&sent.options.images.length===0,'file reference not sent');
 const editorDrop=new DataTransfer();editorDrop.items.add(new File(['again'],'notes.txt',{type:'text/plain'}));
 document.querySelector('.composer-input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:editorDrop}));await wait(250);
 check(document.querySelectorAll('.file-attachment').length===1,'editor drop ignored or duplicated');
 document.querySelector('[aria-label="附加或插入"]').click();await wait(100);
 // The + menu offers "Add files" (any type, images included) and "Add folder".
 check([...document.querySelectorAll('.menu-item')].some(el=>el.textContent.trim()==='添加文件'),'Add files entry missing');
 const chooser=document.querySelector('input[type=file]');let pickerOpened=false;chooser.click=()=>{pickerOpened=true};
 [...document.querySelectorAll('.menu-item')].find(el=>el.textContent.trim()==='添加文件').click();await wait(80);
 check(pickerOpened&&chooser.accept==='','file menu did not invoke unrestricted picker');
 chooser.files=dt.files;chooser.dispatchEvent(new Event('change',{bubbles:true}));await wait(250);
 check(document.querySelectorAll('.file-attachment').length===2,'selected file not loaded');
 render(null,document.getElementById('app'));
 render(h(ProviderForm,{initial:{id:'test',config:{api:'openai-completions',baseUrl:'https://example.invalid',models:[{id:'model',name:'Model',pricing:{currency:'USD',input:1,output:2,cacheRead:0.1,cacheWrite:0.2,tiers:[]}}]}}}),document.getElementById('app'));await wait(100);
 document.querySelector('.pf-model-toggle').click();await wait(400);
 document.querySelector('.pf-pricing .toggle').click();await wait(100);
 check(document.querySelector('.pf-pricing').textContent.includes('($/1M)'),'USD unit missing');
 await pickSelect('.pf-pricing .select-like','CNY');await wait(100);
 check(document.querySelector('.pf-pricing').textContent.includes('(¥/1M)'),'CNY unit not updated');
 const add=[...document.querySelectorAll('.pf-pricing button')].find(el=>el.textContent.includes('添加计价阶梯'));check(add&&!add.classList.contains('ghost')&&add.querySelector('svg'),'tier button missing');add.click();await wait(100);
 check(document.querySelectorAll('.pf-pricing input[type=number]').length===9,'tier fields missing');
 const kv=document.createElement('div');kv.className='kv';kv.style.width='280px';kv.innerHTML='<span>运行过 Shell 命令</span><span>yes</span>';document.body.append(kv);check(getComputedStyle(kv.firstChild).whiteSpace==='nowrap','checkpoint label wraps');
 }
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
