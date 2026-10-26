import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows only project search and tree and submits the explicit deletion choice in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-artifact-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let choice: unknown;
		let result: any;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			server.route("GET", "/api/artifacts", ({ url }) => ({
				entries: [
					{
						name: `report-${url.searchParams.get("scope")}.md`,
						path: "workspaces/w/sessions/s/artifacts/reports/report.md",
						workspaceId: "w",
						sessionId: "s",
						size: 12,
						conversationDeleted: true,
					},
				],
			}));
			server.route("GET", "/api/files/list", () => ({
				entries: [{ name: "AGENTS.md", path: "AGENTS.md", type: "file" }],
			}));
			server.route("GET", "/api/changes", () => ({ files: [] }));
			// The dialog opens at once and fills its counts from here; the delay shows that nothing moves when they arrive.
			server.route("GET", "/api/sessions/delete-impact", async ({ url }) => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				// Only old versions are left of this chat's memories: they still go with it, so the switch is offered.
				if (url.searchParams.get("path") === "retired.jsonl")
					return {
						artifacts: { files: 0, bytes: 0 },
						history: { uploads: { files: 0, bytes: 0 }, toolResults: { files: 0, bytes: 0 } },
						memories: { owned: [], shared: 0, retired: 2 },
					};
				return {
					artifacts: { files: 3, bytes: 2048 },
					history: { uploads: { files: 1, bytes: 10 }, toolResults: { files: 0, bytes: 0 } },
					memories: { owned: [{ id: "workspace/note", name: "A note", scope: "workspace" }], shared: 2 },
				};
			});
			server.route("POST", "/api/sessions/delete", ({ body }) => {
				choice = body;
				return { ok: true };
			});
			for (const route of [
				"/api/workspaces",
				"/api/slots",
				"/api/sessions/unbound",
				"/api/sessions/archived",
				"/api/transcript",
				"/api/resources",
			])
				server.route("GET", route, () => ({ workspaces: [], slots: [], sessions: [], items: [], commands: [] }));
			server.route("GET", "/api/state", () => ({ session: { id: "s" }, flags: {} }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {};
			});
			server.route("POST", "/api/test-result", ({ body }) => {
				result = body;
				return {};
			});
			writeFileSync(
				join(root, "index.html"),
				'<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><img hidden src="/hold"><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {FilesPanel} from '/js/panel-files.js';
import {DeleteChatModal} from '/js/app.js';
import {actions,resolveConfirm} from '/js/actions.js';
import {state,set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const app=document.getElementById('app');
try {
 setView({lang:'zh-CN'}); set({activeSlot:'slot-a',snap:{session:{id:'s'},lastRun:{runId:1}}});
 render(h(FilesPanel),app); await wait(150);
 if(app.querySelectorAll('.panel-toolbar').length!==1) throw Error('extra files toolbar');
 if(!app.querySelector('.panel-toolbar input') || !app.querySelector('[role="tree"]')?.textContent.includes('AGENTS.md')) throw Error('project search or tree missing');
 if([...app.querySelectorAll('button')].some(b=>['项目文件','产出文件','记忆'].includes(b.textContent))) throw Error('removed navigation returned');
 render(null,app);
 const cancelled=actions.deleteSession('chat.jsonl','Saved chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(40);
 const modal=()=>app.querySelector('.delete-chat');
 if(!modal()) throw Error('delete dialog did not open at once');
 const switches=()=>[...app.querySelectorAll('.del-row.opt .del-hit[role="switch"]')];
 if(switches().length!==2 || switches().some(row=>row.getAttribute('aria-checked')==='true')) throw Error('unsafe deletion default');
 if(!app.textContent.includes('正在统计')) throw Error('no counting state');
 const before=modal().offsetHeight;
 await wait(450);
 if(!app.textContent.includes('3 个文件') || !app.textContent.includes('1 条记忆') || !app.textContent.includes('另有 2 条')) throw Error('counts missing: '+app.textContent);
 if(Math.abs(modal().offsetHeight-before)>0.5) throw Error('dialog height moved when the counts arrived');
 if(!app.textContent.includes('保留 1 个附件')) throw Error('kept uploads not shown: '+app.textContent);
 // A real click anywhere on an option row (the drawn switch, the icon, the text) lands on that row's switch button.
 for(const row of app.querySelectorAll('.del-row.opt')) for(const part of ['.toggle','.del-icon','.del-detail']){
  const r=row.querySelector(part).getBoundingClientRect();
  const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
  if(hit!==row.querySelector('.del-hit')) throw Error('a click on '+part+' lands on '+(hit?.className||hit?.tagName)+', not the switch');
 }
 // The "show which" link sits inside the memory card: keys and clicks on it open the list and never flip the switch.
 const link=app.querySelector('.del-label .link-btn');
 link.focus();
 link.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 link.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
 link.click(); await wait(400);
 if(switches()[1].getAttribute('aria-checked')!=='false') throw Error('the show-which link turned on memory deletion');
 if(!app.querySelector('.del-list')?.textContent.includes('A note')) throw Error('show-which did not open the list');
 resolveConfirm(false); await cancelled;
 render(null,app);
 const retired=actions.deleteSession('retired.jsonl','Old chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(450);
 if(switches()[1].disabled || !app.textContent.includes('归档里的 2 个旧版本')) throw Error('archived-only memories not offered: '+app.textContent);
 resolveConfirm(false); await retired;
 render(null,app);
 const deletion=actions.deleteSession('chat.jsonl','Saved chat'); await wait(20);
 render(h(DeleteChatModal,{dialog:state.view.dialog}),app); await wait(450);
 const loaded=modal().offsetHeight;
 switches()[0].click(); await wait(20);
 if(switches()[0].getAttribute('aria-checked')!=='true') throw Error('artifacts switch did not turn on');
 if(Math.abs(modal().offsetHeight-loaded)>0.5) throw Error('dialog height moved when a switch flipped');
 if([...modal().querySelectorAll('.del-detail,.del-label,.del-pill,.btn')].some(el=>el.scrollWidth>el.clientWidth+1)) throw Error('clipped text in the dialog');
 [...app.querySelectorAll('button')].find(b=>b.textContent==='删除').click(); await deletion;
 await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:true})}); document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(e) { await fetch('/api/test-result',{method:'POST',headers:{'Content-Type':'application/json','x-myharness-web':'1'},body:JSON.stringify({ok:false,error:String(e.stack||e)})}); document.body.insertAdjacentHTML('beforeend','<p id="ready">failed</p>'); }
`,
			);
			const address = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${address.port}/test/index.html`,
				readySelector: "#ready",
				label: "Artifacts",
				isSolved: () => true,
			});
			expect(result, page.text).toEqual({ ok: true });
			expect(choice).toEqual({ path: "chat.jsonl", deleteArtifacts: true, deleteMemory: false });
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30000,
);
