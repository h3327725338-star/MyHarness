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
			server.route("GET", "/api/context", () => ({ window: 128000, used: 10000, percent: 7.8 }));
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
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/overlays.css"><link rel="stylesheet" href="/css/panels.css"><div id="app"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {actions,resolveConfirm} from '/js/actions.js';
import {CacheValue,SpeedValue,sessionCache,ContextDetails} from '/js/context-usage.js';
import {ContextPanel} from '/js/panel-context.js';
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
 const measurement=(value,estimated=false)=>({value,estimated});
 const measuredStats={...stats,speed:measurement(25),cache:{prompt:measurement(10000),read:measurement(9925),write:measurement(null),hitRate:measurement(.9925)},latestRequest:{speed:measurement(100),cache:{read:measurement(800),write:measurement(null),hitRate:measurement(.8)},timing:{requestMs:3000,firstOutputMs:2000,generationMs:1000}},timing:{requestMs:measurement(8000),firstOutputMs:measurement(2000),generationMs:measurement(4000),toolMs:measurement(3000)}};
 set({stats:measuredStats,snap:{...state.snap,active:false}});
 render(h(ContextDetails),app); await wait(120);
 if(!app.textContent.includes('25.0 t/s') || app.textContent.includes('100.0 t/s')) throw Error('popover is not cumulative');
 const cacheTitle=[...app.querySelectorAll('[title]')].find(el=>el.title.includes('9.9K'))?.title;
 if(!cacheTitle?.includes('10.0K') || cacheTitle.includes('19.9K')) throw Error('cache denominator counted twice: '+cacheTitle);
 render(h(ContextDetails,{capacityOnly:true}),app); await wait(120);
 if(app.querySelectorAll('.cu-stat').length!==1 || app.querySelector('.kv') || app.querySelector('.cu-actions') || app.textContent.includes('t/s')) throw Error('capacity contains duplicate metrics: '+app.textContent);
 measuredStats.speed=measurement(25,true);
 measuredStats.tokens={input:304325,cacheWrite:0,cacheRead:13284352,output:34400};
 measuredStats.cache.input=measurement(304325);
 measuredStats.cache.read=measurement(13284352,true);
 measuredStats.cache.hitRate=measurement(.9776,true);
 measuredStats.userMessages=1000; measuredStats.assistantMessages=2000; measuredStats.toolCalls=3000;
 measuredStats.tokenAvailability={input:false,cacheRead:false,cacheWrite:false,output:false};
 measuredStats.usageEstimated=true;
 set({stats:{...measuredStats},resources:{tools:[],skills:[],prompts:[],extensions:[],contextFiles:[]},snap:{...state.snap,session:{id:'fixture'},thinking:{supported:false}}});
 render(h(ContextPanel),app); await wait(180);
 const token=app.querySelector('.session-tokens'); const cumulative=app.querySelector('.session-cumulative');
 if(!token?.textContent.includes('输入 304.3K · 缓存写入 — · 缓存命中 13.3M · 输出 34.4K')) throw Error('token format wrong: '+token?.textContent);
 if(!cumulative?.textContent.includes('累计速度 ≈ 25.0 t/s · 累计命中率 ≈ 97.76%')) throw Error('cumulative metrics wrong: '+cumulative?.textContent);
 if(Math.abs(token.getBoundingClientRect().left-cumulative.getBoundingClientRect().left)>.1 || cumulative.getBoundingClientRect().top<=token.getBoundingClientRect().top) throw Error('cumulative row not aligned below tokens');
 const context=app.querySelector('.cu');
 if(context.querySelectorAll('.cu-stat').length!==1 || context.querySelector('.kv') || context.textContent.includes('t/s') || context.textContent.includes('缓存')) throw Error('context duplication remains');
 const controls=context.querySelector('.cu-controls'); const compact=controls?.querySelector('.btn');
 if(!controls?.textContent.includes('自动压缩') || !compact?.textContent.includes('立即压缩')) throw Error('context compression controls missing');
 if(app.querySelector('.ctx-actions').querySelectorAll('button').length!==1 || !app.querySelector('.ctx-actions').textContent.includes('导出 HTML')) throw Error('bottom actions not simplified');
 for(const width of [360,560]) {
  context.style.width=width+'px'; context.style.boxSizing='border-box'; await wait(30);
  const bar=context.querySelector('.cu-bar').getBoundingClientRect(); const group=controls.getBoundingClientRect(); const remaining=context.querySelector('.cu-stat').getBoundingClientRect();
  if(Math.abs(bar.right-group.right)>.1 || Math.abs(bar.right-compact.getBoundingClientRect().right)>.1 || remaining.right>group.left || Math.abs(remaining.top+remaining.height/2-group.top-group.height/2)>2) throw Error('compression row alignment wrong at '+width);
 }
 set({snap:{...state.snap,active:true,autoCompaction:true}}); await wait(50);
 if(!compact.disabled || controls.querySelector('[role="switch"]')?.getAttribute('aria-checked')!=='true') throw Error('compression state not preserved');
 set({snap:{...state.snap,active:false,autoCompaction:false}}); await wait(50);
 if(compact.disabled || controls.querySelector('[role="switch"]')?.getAttribute('aria-checked')!=='false') throw Error('compression state did not update');
 if(/304,?325|13,?284,?352/.test(app.innerHTML)) throw Error('raw long integers remain');
 measuredStats.speed=measurement(null); measuredStats.cache.hitRate=measurement(null); measuredStats.cache.input=measurement(null); measuredStats.tokens.output=undefined;
 set({stats:{...measuredStats}}); await wait(60);
 if(!cumulative.textContent.includes('累计速度 — · 累计命中率 —') || !token.textContent.includes('输入 304.3K') || !token.textContent.includes('输出 —')) throw Error('missing metrics not dashed');
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
