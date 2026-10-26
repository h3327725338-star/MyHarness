import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it
	.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)
	.each(["used by worktree at", "checked out at"])(
	"cascades occupied branch deletion and preserves safe independent deletion (%s)",
	async (occupiedReason) => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-branch-delete-split-"));
		const server = new WebHttpServer();
		const deleted = new Set<string>();
		const requests: Array<{ kind: string; name?: unknown; path?: unknown; force?: unknown; slot?: string }> = [];
		let copyDeleted = false;
		let cleanDeleted = false;
		let cleanDirty = false;
		let protectedChecks = false;
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/branches", () => ({
				branches: [
					{ name: "main", current: true, commit: "a", subject: "main", committedAt: 5 },
					{
						name: "task-copy",
						...(copyDeleted ? {} : { worktreePath: "C:/copies/task-copy" }),
						commit: "b",
						subject: "workspace snapshot",
						committedAt: 4,
					},
					...(cleanDeleted
						? []
						: [{ name: "clean-copy", worktreePath: "C:/copies/clean", commit: "f", committedAt: 3 }]),
					{ name: "stale", commit: "c", subject: "stale", committedAt: 3 },
					{ name: "denied", commit: "d", subject: "locked", committedAt: 2 },
					{ name: "unknown", commit: "e", subject: "unknown failure", committedAt: 1 },
					...(protectedChecks
						? [
								{ name: "protected-main", worktreePath: "C:/copies/main", committedAt: 1 },
								{ name: "protected-current", worktreePath: "C:/copies/current", committedAt: 1 },
							]
						: []),
				].filter((branch) => !deleted.has(branch.name)),
			}));
			server.route("GET", "/api/git/status", () => ({
				gitAvailable: true,
				isRepository: true,
				root: "C:/fixture",
				branch: "main",
			}));
			server.route("GET", "/api/git/worktrees", () => ({
				worktrees: [
					{ path: "C:/fixture", branch: "main", isMain: true, current: true },
					...(copyDeleted ? [] : [{ path: "C:/copies/task-copy", branch: "task-copy" }]),
					...(cleanDeleted
						? []
						: [{ path: "C:/copies/clean", branch: "clean-copy", changes: cleanDirty ? 2 : 0, ahead: 0 }]),
					{ path: "C:/copies/locked", branch: "locked-copy" },
					{ path: "C:/copies/unknown", branch: "unknown-copy" },
					...(protectedChecks
						? [
								{ path: "C:/copies/main", branch: "protected-main", isMain: true },
								{ path: "C:/copies/current", branch: "protected-current", current: true },
							]
						: []),
				],
			}));
			server.route("GET", "/api/test/requests", () => requests);
			server.route("GET", "/api/test/raw-error", () => {
				throw new Error("error: cannot delete branch '任务分支' used by worktree at 'C:/副本目录/task-copy'");
			});
			server.route("POST", "/api/test/protected", () => {
				protectedChecks = true;
				return { ok: true };
			});
			server.route("POST", "/api/test/dirty", () => {
				cleanDirty = true;
				return { ok: true };
			});
			server.route("POST", "/api/test/reset-copy", () => {
				copyDeleted = false;
				return { ok: true };
			});
			server.route("POST", "/api/git/branches/delete", async ({ body, req }) => {
				const payload = body as { name?: unknown; force?: unknown };
				requests.push({ ...payload, kind: "branch", slot: String(req.headers["x-myharness-slot"] ?? "") });
				await new Promise((resolve) => setTimeout(resolve, 100));
				const name = String(payload.name ?? "");
				if (
					name === "clean-copy" &&
					payload.force === true &&
					(payload as { deleteWorktrees?: boolean }).deleteWorktrees === true
				) {
					cleanDeleted = true;
					return { ok: true };
				}
				if (
					name === "task-copy" &&
					payload.force === true &&
					(payload as { deleteWorktrees?: boolean }).deleteWorktrees === true
				)
					copyDeleted = true;
				if (name === "task-copy" && !copyDeleted)
					throw new Error(`error: cannot delete branch 'task-copy' ${occupiedReason} 'C:/copies/task-copy'`);
				if (name === "task-copy" || name === "stale") {
					if (payload.force === true) {
						deleted.add(name);
						return { ok: true };
					}
					throw new Error(`error: The branch '${name}' is not fully merged.`);
				}
				if (name.startsWith("protected-"))
					throw new Error(`error: cannot delete branch '${name}' ${occupiedReason} 'C:/copies/${name.slice(10)}'`);
				if (name === "denied") throw new Error("fatal: cannot lock ref 'refs/heads/denied': Permission denied");
				throw new Error("fatal: unexpected fixture error 731");
			});
			server.route("POST", "/api/git/worktrees/delete", async ({ body, req }) => {
				const payload = body as { path?: unknown; force?: unknown };
				requests.push({ ...payload, kind: "copy", slot: String(req.headers["x-myharness-slot"] ?? "") });
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (payload.path === "C:/copies/locked") throw new Error("fatal: 'C:/copies/locked' is locked");
				if (payload.path === "C:/copies/unknown") throw new Error("fatal: unexpected fixture error 732");
				if (payload.path !== "C:/copies/task-copy") throw new Error("Unexpected deletion target");
				if (payload.force !== true)
					throw new Error(
						"删除 Worktree 失败：fatal: 'C:/copies/task-copy' contains modified or untracked files, use --force to delete it",
					);
				copyDeleted = true;
				return { ok: true };
			});
			for (const action of ["enter", "start", "combine"])
				server.route("POST", `/api/git/worktrees/${action}`, () => {
					requests.push({ kind: action });
					throw new Error("Navigation to a copy must never enter, start, combine or delete it");
				});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {BranchChip} from '/js/branch-menu.js';
import {PanelBody} from '/js/command-panel.js';
import {api,set,setView,state} from '/js/store.js';
import {setLang} from '/js/lang.js';
import {useWorkspaceTitle} from '/js/workspace-title.js';
function Title(){useWorkspaceTitle();return null;}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await wait(50)}throw Error('timed out waiting for UI')};
const row=name=>[...document.querySelectorAll('.branch-row')].find(r=>r.querySelector('.branch-name').textContent===name);
const branchPanel=()=>document.querySelector('[aria-label="删除分支？"]');
const copyPanel=()=>document.querySelector('[aria-label="删除副本？"]');
const button=(el,text)=>[...(el?.querySelectorAll('button')||[])].find(b=>b.textContent===text);
const requests=()=>fetch('/api/test/requests').then(r=>r.json());
const copyRow=path=>document.querySelector('.branch-row[data-copy-path="'+path+'"]');
const safeBranch=async(name)=>{row(name).querySelector('.branch-del').click();await wait(100);if(!branchPanel())row(name).querySelector('.branch-confirm').click();};
try {
 setView({motion:'on',lang:'zh-CN'}); setLang('zh-CN');
 set({connected:true,snap:{session:{file:'draft'}},activeSlot:'slot',slots:[{slot:'slot',cwd:'C:/fixture',sessionFile:'draft',sessionId:'id'}]});
 setLang('en');try {await api('/api/test/raw-error');throw Error('fixture did not fail')} catch(error) {check(error.rawMessage?.includes('used by worktree at')&&error.rawMessage.includes('C:/副本目录'),'localization discarded the original Git reason for a non-English path');}setLang('zh-CN');
 const titleHost=document.createElement('div');document.body.append(titleHost);render(h(Title),titleHost);
 for(const [status,title] of [
  [{isRepository:true,branch:'main'},'MyHarness-main'],
  [{isRepository:true,linkedWorktree:true,branch:'myharness-subagent-xxx'},'worktree-subagent-xxx'],
  [{isRepository:true,linkedWorktree:true,branch:'paired-off'},'worktree-paired-off'],
  [{isRepository:true,linkedWorktree:true,branch:'task',copyName:'paired-on'},'worktree-paired-on'],
  [{isRepository:true,branch:'main'},'MyHarness-main']
 ]){set({gitStatus:status});await until(()=>document.title===title);}
 document.getElementById('app').style.cssText='position:fixed;bottom:20px;left:20px';
 render(h(BranchChip,{gitStatus:{branch:'main'}}),document.getElementById('app'));await wait(50);
 document.querySelector('.branch-chip').click();await until(()=>row('task-copy')&&row('clean-copy')&&row('stale')&&copyRow('C:/copies/locked'));
 check(!row('main').querySelector('.branch-del'),'current branch offers deletion');
 check(row('task-copy').querySelector('.branch-sub')?.textContent.includes('task-copy'),'a copy row does not name its folder');
 // A copy and its branch: one question under the row that names what would be lost, a single red button, Cancel first.
 row('task-copy').querySelector('.branch-del').click();await until(()=>copyPanel()?.textContent.includes('读不到'));
 check(row('task-copy').parentElement.contains(copyPanel()),'the question does not open under its row');
 check(copyPanel().querySelectorAll('.danger.solid').length===1&&button(copyPanel(),'丢弃并删除')?.classList.contains('solid'),'the question must offer exactly one red button');
 check(button(copyPanel(),'打开这个副本')&&!button(copyPanel(),'去对应副本'),'a copy holding work must offer to open it, nothing else');
 await until(()=>document.activeElement===button(copyPanel(),'取消'));
 check((await requests()).length===0,'opening the question writes');
 button(copyPanel(),'取消').click();await until(()=>!copyPanel());
 check((await requests()).length===0&&row('task-copy'),'cancel deletes');
 row('task-copy').querySelector('.branch-del').click();await until(()=>button(copyPanel(),'丢弃并删除'));
 button(copyPanel(),'丢弃并删除').click();
 await until(()=>!row('task-copy')&&!copyPanel());
 let history=await requests();check(history.length===1&&history[0].kind==='branch'&&history[0].name==='task-copy'&&history[0].force===true&&history[0].deleteWorktrees===true,'copy and branch must go in one explicit backend request');
 check(!state.toasts.some(t=>t.type==='error'),'deleting a copy and its branch raised an error toast');
 // A clean copy says nothing is lost. If it changed after the question opened, the click only updates the question.
 row('clean-copy').querySelector('.branch-del').click();await until(()=>copyPanel()?.textContent.includes('不会丢'));
 check(!button(copyPanel(),'打开这个副本')&&button(copyPanel(),'删除'),'a clean copy question is wrong');
 await fetch('/api/test/dirty',{method:'POST',headers:{'x-myharness-web':'1'}});
 button(copyPanel(),'删除').click();await until(()=>copyPanel()?.textContent.includes('有了变化')&&copyPanel().textContent.includes('2 个未提交的改动'));
 check((await requests()).length===1&&row('clean-copy'),'a copy that changed after the question was deleted anyway');
 button(copyPanel(),'丢弃并删除').click();await until(()=>!row('clean-copy')&&!copyPanel());
 history=await requests();check(history.length===2&&history[1].name==='clean-copy'&&history[1].deleteWorktrees===true,'confirming the updated question did not delete');
 // Unmerged branch: Git refuses the safe delete; the panel explains it, cancel sends nothing, force is one explicit click.
 await safeBranch('stale');await until(()=>branchPanel()?.textContent.includes('尚未合并的提交'));
 check(!branchPanel().querySelector('.c-danger'),'the refusal is shown as red text');
 let count=(await requests()).length;button(branchPanel(),'取消').click();await until(()=>!branchPanel());
 check(!branchPanel()&&(await requests()).length===count&&row('stale'),'cancel deletes the unmerged branch');
 await safeBranch('stale');await until(()=>branchPanel()?.textContent.includes('尚未合并的提交'));
 set({snap:{...state.snap,active:true}});await wait(50);
 check(button(branchPanel(),'强制删除分支').disabled,'running task permits branch force deletion');
 set({snap:{...state.snap,active:false}});await wait(50);
 button(branchPanel(),'强制删除分支').click();await until(()=>!row('stale')&&!branchPanel());
 history=await requests();check(history.at(-1).name==='stale'&&history.at(-1).force===true&&!history.at(-1).deleteWorktrees,'force is not explicit or touches copies');
 // Permission and unknown failures are explained inline, preserve details, and do not pretend force fixes them.
 await safeBranch('denied');await until(()=>branchPanel()?.textContent.includes('访问权限'));
 check(!button(branchPanel(),'强制删除分支')&&button(branchPanel(),'重试删除'),'permission error wrongly offers force');
 check(branchPanel().querySelector('details').textContent.includes('Permission denied'),'permission details lost');
 button(branchPanel(),'取消').click();await until(()=>!branchPanel());
 await safeBranch('unknown');await until(()=>branchPanel()?.textContent.includes('暂时无法确定具体原因'));
 check(!button(branchPanel(),'强制删除分支')&&button(branchPanel(),'重试删除'),'unknown error wrongly offers force');
 check(branchPanel().querySelector('details').textContent.includes('731'),'unknown error details lost');
 button(branchPanel(),'取消').click();await until(()=>!branchPanel());
 // Copies whose branch the list does not have still get a row, and their failures are explained the same way.
 for (const path of ['C:/copies/locked','C:/copies/unknown']) {
  copyRow(path).querySelector('.branch-del').click();await until(()=>button(copyPanel(),'丢弃并删除'));button(copyPanel(),'丢弃并删除').click();
  await until(()=>copyPanel()?.querySelector('[role="alert"]'));
  check(!button(copyPanel(),'强制删除副本')&&button(copyPanel(),'重试删除'),'non-dirty copy error wrongly offers force: '+path);
  check(copyPanel().querySelector('details').textContent.includes(path.includes('locked')?'locked':'732'),'copy details lost');
  button(copyPanel(),'取消').click();await until(()=>!copyPanel());
 }
 history=await requests();check(history.every(r=>['branch','copy'].includes(r.kind)&&r.slot==='slot'),'deletion misrouted to another chat or go-to wrote state');
 // The alternate /git -> Worktrees entry must use the same copy-only confirmation and friendly force retry.
 render(null,document.getElementById('app'));
 render(h(PanelBody,{cmd:{name:'git',nonce:'delete-test'},onClose:()=>{}}),document.getElementById('app'));
 const cpRow=text=>[...document.querySelectorAll('.cp-row')].find(r=>r.querySelector('.cp-label')?.textContent===text);
 await until(()=>cpRow('Worktree'));cpRow('Worktree').click();await until(()=>cpRow('unknown-copy'));
 cpRow('unknown-copy').click();await until(()=>cpRow('删除副本'));
 count=(await requests()).length;cpRow('删除副本').click();await until(()=>document.querySelector('.cp-sub')?.textContent.includes('保留分支'));
 check((await requests()).length===count,'command-panel opens confirmation but deletes immediately');
 check(document.querySelector('.cp-row.sel .cp-label')?.textContent==='取消','command-panel default is unsafe');
 cpRow('删除副本').click();await until(()=>document.querySelector('.cp-screen').textContent.includes('暂时无法确定具体原因'));
 check(!cpRow('强制删除副本')&&cpRow('重试删除'),'alternate unknown error offers force');
 check(document.querySelector('details:not([open])')?.textContent.includes('732'),'alternate raw details lost or expanded');
 cpRow('取消').click();await until(()=>cpRow('删除副本'));
 document.querySelector('.cp-head [aria-label="返回"]').click();await until(()=>cpRow('locked-copy'));
 cpRow('locked-copy').click();await until(()=>cpRow('删除副本'));cpRow('删除副本').click();await wait(50);
 cpRow('删除副本').click();await until(()=>document.querySelector('.cp-screen').textContent.includes('锁住'));
 check(!cpRow('强制删除副本'),'alternate locked error offers force');
 cpRow('取消').click();await until(()=>cpRow('删除副本'));
 document.querySelector('.cp-head [aria-label="返回"]').click();await until(()=>cpRow('unknown-copy'));
 // Reset only mock fixture state to exercise a second independent copy deletion; no real files or refs exist here.
 await fetch('/api/test/reset-copy',{method:'POST',headers:{'x-myharness-web':'1'}});
 document.querySelector('.cp-head [aria-label="返回"]').click();await until(()=>cpRow('Worktree'));
 cpRow('Worktree').click();await until(()=>cpRow('task-copy'));
 cpRow('task-copy').click();await until(()=>cpRow('删除副本'));cpRow('删除副本').click();await wait(50);
 cpRow('删除副本').click();await until(()=>cpRow('强制删除副本'));
 check(document.querySelector('.cp-screen').textContent.includes('未提交的改动'),'alternate dirty error not explained');
 count=(await requests()).length;cpRow('强制删除副本').click();await until(()=>document.querySelector('.cp-screen').textContent.includes('确认强制删除这个副本'));
 check((await requests()).length===count,'alternate force writes before confirmation');
 check(document.querySelector('.cp-row.sel .cp-label')?.textContent==='取消','alternate force confirmation not safe by default');
 cpRow('强制删除副本').click();await until(()=>cpRow('unknown-copy')&&!cpRow('task-copy'));
 history=await requests();check(history.at(-1).kind==='copy'&&history.at(-1).force===true&&history.at(-1).slot==='slot','alternate force does not target just the selected copy');
 // The main copy and the copy this chat runs in never offer deletion.
 render(null,document.getElementById('app'));
 await fetch('/api/test/protected',{method:'POST',headers:{'x-myharness-web':'1'}});
 render(h(BranchChip,{gitStatus:{branch:'main'}}),document.getElementById('app'));await wait(50);
 document.querySelector('.branch-chip').click();await until(()=>row('protected-main')&&row('protected-current'));
 for (const name of ['protected-main','protected-current']) check(!row(name).querySelector('.branch-del'),'protected copy offers deletion: '+name);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Branch and copy deletion",
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
