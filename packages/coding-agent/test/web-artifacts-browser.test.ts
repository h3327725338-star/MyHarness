import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows artifact scopes and submits the explicit deletion choice in a real browser",
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
			server.route("GET", "/api/files/list", () => ({ entries: [] }));
			server.route("GET", "/api/changes", () => ({ files: [] }));
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
				'<div id="app"></div><img hidden src="/hold"><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {FilesPanel} from '/js/panel-files.js';
import {ConfirmModal} from '/js/app.js';
import {actions,resolveConfirm} from '/js/actions.js';
import {state,set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms)); const app=document.getElementById('app');
try {
 setView({lang:'zh-CN'}); set({activeSlot:'slot-a',snap:{session:{id:'s'},lastRun:{runId:1}}});
 render(h(FilesPanel),app); await wait(150);
 [...app.querySelectorAll('button')].find(b=>b.textContent==='产出文件').click(); await wait(150);
 if(!app.textContent.includes('report-session.md')) throw Error('session scope missing');
 [...app.querySelectorAll('button')].find(b=>b.textContent==='所有工作区').click(); await wait(150);
 if(!app.textContent.includes('report-global.md') || !app.textContent.includes('来源对话已删除')) throw Error('global scope missing');
 if(!app.querySelector('a').href.includes('slot=slot-a')) throw Error('download slot missing');
 const cancelled=actions.deleteSession('chat.jsonl','Saved chat'); await wait(20);
 render(h(ConfirmModal,{dialog:state.view.dialog}),app); await wait(40);
 if(app.querySelector('input').checked) throw Error('unsafe deletion default');
 resolveConfirm(false); await cancelled;
 render(null,app);
 const deletion=actions.deleteSession('chat.jsonl','Saved chat'); await wait(20);
 render(h(ConfirmModal,{dialog:state.view.dialog}),app); await wait(40);
 app.querySelector('input').click(); await wait(20);
 if(!app.textContent.includes('移除工作区和全局')) throw Error('deletion impact missing');
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
			expect(choice).toEqual({ path: "chat.jsonl", deleteArtifacts: true });
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30000,
);
