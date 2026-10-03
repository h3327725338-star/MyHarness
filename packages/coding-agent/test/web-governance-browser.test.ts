import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"confirms deletion, animates archive and rejects shortcut conflicts in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-governance-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let deleted = false;
		let archived = false;
		const info = {
			path: "C:/fixture/chat.jsonl",
			id: "chat",
			name: "Saved chat",
			modified: Date.now(),
			firstMessage: "hello",
		};
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
			server.route("GET", "/api/sessions/unbound", () => ({ sessions: deleted || archived ? [] : [info] }));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: archived && !deleted ? [info] : [] }));
			server.route("GET", "/api/transcript", () => ({ items: [] }));
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/state", () => ({
				items: [],
				session: { id: "blank", file: null },
				app: {},
				flags: {},
				thinking: {},
				run: {},
			}));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				contextFiles: [],
				tools: [],
				skills: [],
				templates: [],
				extensions: [],
			}));
			server.route("GET", "/api/settings", () => ({ items: [] }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/sessions/archive", ({ body }) => {
				archived = (body as any).archived !== false;
				return { ok: true };
			});
			server.route("POST", "/api/sessions/delete", () => {
				deleted = true;
				return { ok: true };
			});
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {actions,resolveConfirm} from '/js/actions.js';
import {CacheValue,SpeedValue,sessionCache} from '/js/context-usage.js';
import {loadWorkspaces,set,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const app=document.getElementById('app');
try {
 document.documentElement.dataset.motion='on';
 setView({lang:'zh-CN',motion:'on',expanded:{'<general>':true,'<archived>':true}});
 await loadWorkspaces(); render(h(Sidebar),app); await wait(400);
 const row=document.querySelector('.chat-row');
 if(!row) throw Error('saved row missing');
 const base=state.snap;
 set({activeSlot:'draft',slots:[{slot:'draft',sessionFile:'C:/fixture/draft.jsonl',sessionId:'draft',unbound:true,hasContent:false}],snap:{...base,session:{id:'draft',file:'C:/fixture/draft.jsonl'}}});
 await wait(450);
 const draft=[...document.querySelectorAll('.chat-row')].find(r=>r.textContent.includes('新对话'));
 if(!draft) throw Error('blank draft missing');
 if(draft.closest('.collapse').getBoundingClientRect().height<33) throw Error('blank draft never opened: '+draft.closest('.collapse').outerHTML);
 set({activeSlot:'saved',slots:[],snap:base}); await wait(90);
 const draftHeight=draft.closest('.collapse')?.getBoundingClientRect().height;
 if(!(draftHeight>0 && draftHeight<34)) throw Error('blank draft exit hard cut: '+draftHeight);
 await wait(400);
 if(draft.isConnected) throw Error('blank draft not removed');
 row.querySelector('button').click(); await wait(100);
 const archive=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='归档');
 if(!archive) throw Error('archive menu missing'); archive.click(); await wait(100);
 const height=row.closest('.collapse').getBoundingClientRect().height;
 if(height<=0 || height>=34) throw Error('archive exit hard cut: '+height);
 await wait(500);
 const rows=[...document.querySelectorAll('.chat-row')];
 if(rows.length!==1 || !rows[0].closest('.ws').textContent.includes('归档')) throw Error('archive membership wrong');
 await actions.archiveSession('C:/fixture/chat.jsonl',false); await wait(400);
 const deletion=actions.deleteSession('C:/fixture/chat.jsonl','Saved chat'); await wait(30);
 if(state.view.dialog?.confirmLabel!=='删除') throw Error('confirmation missing');
 resolveConfirm(true); await deletion; await wait(400);
 if(document.querySelector('.chat-row')) throw Error('deleted row remains');
 setView({settingsOpen:true,settingsSection:'shortcuts'}); render(h(SettingsModal),app); await wait(200);
 const inputs=[...document.querySelectorAll('[data-shortcut-editor]')];
 if(inputs.length!==6) throw Error('shortcut settings missing');
 inputs[1].dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,altKey:true,bubbles:true,cancelable:true})); await wait(100);
 if(inputs[1].getAttribute('aria-invalid')!=='true' || state.view.shortcuts.newChat) throw Error('conflict saved');
 if(!document.querySelector('[role=alert]')?.textContent.includes('冲突')) throw Error('conflict warning missing');
 inputs[1].dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,altKey:true,bubbles:true,cancelable:true})); await wait(100);
 if(state.view.shortcuts.newChat!=='Ctrl+Alt+J') throw Error('custom key not saved');
 if(!JSON.stringify(localStorage).includes('Ctrl+Alt+J')) throw Error('custom key not persisted');
 const stats={tokens:{input:75,cacheRead:9925,cacheWrite:0,output:500}};
 const cache=sessionCache(stats); const speed={state:'live',tps:42.5,live:true};
 render(h('div',{},h(CacheValue,{session:cache}),h(CacheValue,{session:cache}),h(SpeedValue,{speed}),h(SpeedValue,{speed})),app); await wait(50);
 if(app.textContent.split('99.25%').length!==3 || app.textContent.split('43 t/s').length!==3) throw Error('meter values diverged');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Session governance",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			expect(deleted).toBe(true);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60000,
);
