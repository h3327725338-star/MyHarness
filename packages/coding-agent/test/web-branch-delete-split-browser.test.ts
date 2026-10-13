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
	"keeps branch and copy deletion separate with visible, explained force retries (%s)",
	async (occupiedReason) => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-branch-delete-split-"));
		const server = new WebHttpServer();
		const deleted = new Set<string>();
		const requests: Array<{ kind: string; name?: unknown; path?: unknown; force?: unknown; slot?: string }> = [];
		let copyDeleted = false;
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
					{ path: "C:/fixture", isMain: true, current: true },
					...(copyDeleted ? [] : [{ path: "C:/copies/task-copy", branch: "task-copy" }]),
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
			server.route("POST", "/api/test/reset-copy", () => {
				copyDeleted = false;
				return { ok: true };
			});
			server.route("POST", "/api/git/branches/delete", async ({ body, req }) => {
				const payload = body as { name?: unknown; force?: unknown };
				requests.push({ ...payload, kind: "branch", slot: String(req.headers["x-myharness-slot"] ?? "") });
				await new Promise((resolve) => setTimeout(resolve, 100));
				const name = String(payload.name ?? "");
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
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await wait(50)}throw Error('timed out waiting for UI')};
const row=name=>[...document.querySelectorAll('.branch-row')].find(r=>r.querySelector('.branch-name').textContent===name);
const branchPanel=()=>document.querySelector('[aria-label="删除分支？"]');
const copyPanel=()=>document.querySelector('[aria-label="删除副本？"]');
const button=(el,text)=>[...(el?.querySelectorAll('button')||[])].find(b=>b.textContent===text);
const requests=()=>fetch('/api/test/requests').then(r=>r.json());
const safeBranch=async(name)=>{row(name).querySelector('.branch-del').click();await wait(50);row(name).querySelector('.branch-confirm').click();};
try {
 setView({motion:'on',lang:'zh-CN'}); setLang('zh-CN');
 set({connected:true,snap:{session:{file:'draft'}},activeSlot:'slot',slots:[{slot:'slot',cwd:'C:/fixture',sessionFile:'draft',sessionId:'id'}]});
 setLang('en');try {await api('/api/test/raw-error');throw Error('fixture did not fail')} catch(error) {check(error.rawMessage?.includes('used by worktree at')&&error.rawMessage.includes('C:/副本目录'),'localization discarded the original Git reason for a non-English path');}setLang('zh-CN');
 document.getElementById('app').style.cssText='position:fixed;bottom:20px;left:20px';
 render(h(BranchChip,{gitStatus:{branch:'main'}}),document.getElementById('app'));await wait(50);
 document.querySelector('.branch-chip').click();await until(()=>document.querySelectorAll('.branch-row').length===5);
 check(!row('main').querySelector('.branch-del'),'current branch offers deletion');
 // Occupied branch: safe and force requests only target the branch, and both explain the refusal.
 check(row('task-copy').querySelector('[aria-label="删除分支 task-copy"]'),'occupied branch delete entry missing');
 check(!document.body.textContent.includes('删除副本和分支'),'combined deletion entry is present');
 await safeBranch('task-copy');
 await until(()=>branchPanel()?.textContent.includes('强制删除也不能跳过'));
 check(button(branchPanel(),'强制删除分支')?.classList.contains('solid'),'occupied branch force button is not prominent');
 check(branchPanel().querySelector('details:not([open])'),'raw error must be collapsed, not replace the explanation');
 const forceRow=row('task-copy').querySelector('.branch-confirm');
 forceRow.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));await wait(100);
 check(row('task-copy').querySelector('.branch-confirm')?.textContent==='强制删除分支','force button disappears when mouse leaves');
 check(document.activeElement===button(branchPanel(),'取消'),'refusal must focus the safe option');
 button(branchPanel(),'强制删除分支').click();await until(()=>branchPanel()?.textContent.includes('确认强制删除这个分支吗'));
 check((await requests()).length===1,'opening force confirmation deletes a branch');
 button(branchPanel(),'强制删除分支').click();await until(()=>branchPanel()?.textContent.includes('强制删除也没成功'));
 check(branchPanel().textContent.includes('分支和副本都没被删除'),'force failure does not explain what was preserved');
 check(button(branchPanel(),'强制删除分支')&&!button(branchPanel(),'强制删除分支').disabled,'force button lost after occupied force failure');
 let history=await requests();check(history.length===2&&history.every(r=>r.kind==='branch')&&history[1].force===true,'occupied branch action deletes a copy or loses force flag');
 // Go-to is read-only. It clears a hiding search, opens the copy group, highlights and focuses the right copy.
 const search=document.querySelector('.pop-search input');search.value='stale';search.dispatchEvent(new Event('input',{bubbles:true}));await wait(50);
 button(branchPanel(),'去对应副本').click();await until(()=>document.querySelector('.branch-copy-target'));
 await until(()=>document.activeElement===document.querySelector('.branch-copy-target'));
 check(search.value===''&&document.querySelector('.branch-wt-heading').getAttribute('aria-expanded')==='true','go-to does not reveal the copy list');
 check(document.querySelector('.branch-copy-target').dataset.copyPath==='C:/copies/task-copy','go-to highlights wrong copy');
 check((await requests()).length===2,'go-to performs a write');
 const target=document.querySelector('.branch-copy-target');check(getComputedStyle(target.querySelector('.branch-copy-actions')).opacity==='1','target copy controls remain hidden');
 target.querySelector('[aria-label="删除副本"]').click();await until(()=>copyPanel());
 check(copyPanel().textContent.includes('保留分支'),'copy confirmation does not explain split deletion');
 button(copyPanel(),'删除').click();await until(()=>copyPanel()?.textContent.includes('安全删除被拒绝'));
 check(button(copyPanel(),'强制删除副本')?.classList.contains('solid'),'dirty copy has no prominent force button');
 check(copyPanel().textContent.includes('新增文件')&&copyPanel().textContent.includes('保留分支'),'copy force consequences incomplete');
 button(copyPanel(),'强制删除副本').click();await until(()=>copyPanel()?.textContent.includes('确认强制删除这个副本'));
 check((await requests()).length===3,'opening copy force confirmation writes prematurely');
 button(copyPanel(),'强制删除副本').click();await until(()=>!copyPanel()&&document.querySelectorAll('.branch-copy').length===2);
 check(row('task-copy'),'copy deletion also removed its branch');
 check(button(branchPanel(),'强制删除分支'),'copy deletion loses the branch force button');
 history=await requests();check(history.length===4&&history[2].kind==='copy'&&!history[2].force&&history[3].kind==='copy'&&history[3].force===true,'copy actions touched branch or skipped force confirmation');
 const confirmedRowForce=row('task-copy').querySelector('.branch-confirm');confirmedRowForce.click();confirmedRowForce.click();await until(()=>!row('task-copy')&&!branchPanel());
 history=await requests();check(history.length===5&&history[4].kind==='branch'&&history[4].force===true,'branch not separately forced after copy deletion');
 // Unmerged branch: cancellation sends nothing, running tasks disable force, retry is explicit and confirmed.
 await safeBranch('stale');await until(()=>branchPanel()?.textContent.includes('尚未合并的提交'));
 button(branchPanel(),'强制删除分支').click();await wait(50);
 let count=(await requests()).length;button(branchPanel(),'取消').click();await wait(50);
 check(!branchPanel()&&(await requests()).length===count&&row('stale'),'cancel force deletes the unmerged branch');
 await safeBranch('stale');await until(()=>branchPanel()?.textContent.includes('尚未合并的提交'));
 button(branchPanel(),'强制删除分支').click();await wait(50);
 set({snap:{...state.snap,active:true}});await wait(50);
 check(button(branchPanel(),'强制删除分支').disabled&&row('stale').querySelector('.branch-confirm').disabled,'running task permits branch force deletion');
 set({snap:{...state.snap,active:false}});await wait(50);
 button(branchPanel(),'强制删除分支').click();await until(()=>!row('stale')&&!branchPanel());
 // Permission and unknown failures are explained inline, preserve details, and do not pretend force fixes them.
 await safeBranch('denied');await until(()=>branchPanel()?.textContent.includes('访问权限'));
 check(!button(branchPanel(),'强制删除分支')&&button(branchPanel(),'重试删除'),'permission error wrongly offers force');
 check(branchPanel().querySelector('details').textContent.includes('Permission denied'),'permission details lost');
 button(branchPanel(),'取消').click();await wait(50);
 await safeBranch('unknown');await until(()=>branchPanel()?.textContent.includes('暂时无法确定具体原因'));
 check(!button(branchPanel(),'强制删除分支')&&button(branchPanel(),'重试删除'),'unknown error wrongly offers force');
 check(branchPanel().querySelector('details').textContent.includes('731'),'unknown error details lost');
 button(branchPanel(),'取消').click();await wait(50);
 for (const path of ['C:/copies/locked','C:/copies/unknown']) {
  const copy=[...document.querySelectorAll('.branch-copy')].find(r=>r.dataset.copyPath===path);
  copy.querySelector('[aria-label="删除副本"]').click();await wait(50);button(copyPanel(),'删除').click();
  await until(()=>copyPanel()?.querySelector('[role="alert"]'));
  check(!button(copyPanel(),'强制删除副本')&&button(copyPanel(),'重试删除'),'non-dirty copy error wrongly offers force: '+path);
  check(copyPanel().querySelector('details').textContent.includes(path.includes('locked')?'locked':'732'),'copy details lost');
  button(copyPanel(),'取消').click();await wait(50);
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
 // Protected main/current targets must explain why their copy cannot be deleted, not point at a missing button.
 render(null,document.getElementById('app'));
 await fetch('/api/test/protected',{method:'POST',headers:{'x-myharness-web':'1'}});
 render(h(BranchChip,{gitStatus:{branch:'main'}}),document.getElementById('app'));await wait(50);
 document.querySelector('.branch-chip').click();await until(()=>row('protected-main'));
 for (const name of ['protected-main','protected-current']) {
  await safeBranch(name);await until(()=>button(branchPanel(),'去对应副本'));
  count=(await requests()).length;button(branchPanel(),'去对应副本').click();await until(()=>document.querySelector('.branch-copy-target')?.dataset.copyBranch===name&&document.querySelector('.branch-hint')?.textContent.includes('主副本本身必须保留'));
  const protectedRow=document.querySelector('.branch-copy-target');check(protectedRow?.dataset.copyBranch===name,'protected go-to picked wrong copy');
  const trash=protectedRow.querySelector('[aria-label="删除副本"]');check(!trash||trash.disabled,'protected copy permits deletion');
  check((await requests()).length===count,'protected go-to performs a deletion');
  button(branchPanel(),'取消').click();await wait(50);
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
