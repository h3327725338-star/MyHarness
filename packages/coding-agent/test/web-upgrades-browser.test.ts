import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"preserves expanded steps through completion and renders Markdown change cards automatically",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-upgrades-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("GET", "/api/changes/card-diff", ({ url }) => ({
				summary: {},
				patch: url.searchParams.get("path")?.endsWith(".ts")
					? `--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,60 @@\n${Array.from({ length: 60 }, (_, i) => `+const v${i} = ${i};`).join("\n")}\n`
					: "--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-# Before\n+# After\n",
			}));
			server.route("GET", "/api/settings", () => ({
				items: [
					{ id: "subAgent", section: "Assistants", label: "Sub-agent (Explore)", type: "boolean", value: false },
					{
						id: "visionAssistant",
						section: "Assistants",
						label: "Vision Assistant",
						type: "boolean",
						value: false,
					},
					{ id: "autoMemory", section: "Assistants", label: "Auto Memory", type: "boolean", value: false },
					{
						id: "codeIntelligence.enabled",
						section: "Tools",
						label: "Code Intelligence",
						type: "boolean",
						value: false,
					},
					{
						id: "images.autoResize",
						section: "Images",
						label: "Auto-resize images",
						type: "boolean",
						value: false,
					},
					{ id: "steeringMode", section: "Agent", label: "Steering messages", type: "boolean", value: false },
					{ id: "followUpMode", section: "Agent", label: "Follow-up messages", type: "boolean", value: false },
					{
						id: "popupNotifications",
						section: "Notifications",
						label: "Desktop popup when a task ends",
						type: "boolean",
						value: false,
					},
				],
			}));
			server.route("GET", "/api/trust", () => ({ requiresTrust: false }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/overlays.css"><div id="checks"></div><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {Collapse,Modal} from '/js/ui.js';
import {StepCounts} from '/js/step-counts.js';
import {SettingsModal,sectionOf} from '/js/overlays-settings.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 document.documentElement.dataset.motion='on';
 const checks=document.getElementById('checks');
 render(h(Modal,{title:'Settings',focusInput:false},h('input',{'aria-label':'Reading width'})),checks);
 await wait(100);
 if(document.activeElement!==document.querySelector('.modal')) throw Error('settings input focused');
 const fold=open=>render(h(Collapse,{open},h('div',{style:'height:200px'},'content')),checks);
 fold(false); await wait(50); fold(true); await wait(100);
 const mid=document.querySelector('.collapse').getBoundingClientRect().height;
 if(mid<=0 || mid>=200) throw Error('expand hard cut: '+mid);
 await wait(300); fold(false); await wait(100);
 const closing=document.querySelector('.collapse').getBoundingClientRect().height;
 if(closing<=0 || closing>=200) throw Error('collapse hard cut: '+closing);
 await wait(300);
 const counts=(additions,deletions,running)=>render(h(StepCounts,{additions,deletions,running}),checks);
 counts(undefined,undefined,true); await wait(50);
 if(document.querySelectorAll('.count-sign.pop').length!==2 || !document.querySelector('.count-sign').getAnimations().length) throw Error('signs not popping');
 counts(1,2,true); await wait(50);
 if([...document.querySelectorAll('.count-current')].some(n=>n.textContent!=='0')) throw Error('counts bypassed threshold');
 counts(4,3,true); await wait(50);
 const up=document.querySelector('.count-current.roll-up'),down=document.querySelector('.count-current.roll-down');
 if(!up || !down || !up.getAnimations().length || !down.getAnimations().length) throw Error('counts not animating');
 if(getComputedStyle(up).transform===getComputedStyle(down).transform) throw Error('count directions identical');
 await wait(350); const first=up;
 await wait(3000);
 if(document.querySelector('.count-current.roll-up')!==first || first.getAnimations().some(a=>a.playState==='running')) throw Error('unchanged replay');
 counts(5,5,true); await wait(50);
 if(document.querySelector('.count-current.roll-up')!==first) throw Error('remainder rolled early');
 counts(5,5,false); await wait(50);
 if(document.querySelector('.count-current.roll-up')===first || !document.querySelector('.count-current.roll-up').getAnimations().length) throw Error('final counts not animating');
 render(null,checks);
 set({models:[]}); setView({settingsSection:'conversation'});
 render(h(SettingsModal,{}),checks); await wait(150);
 let body=document.querySelector('.settings-body');
 if(!body.textContent.includes('Message delivery') || body.textContent.includes('notification') || body.textContent.includes('Notifications')) throw Error('conversation grouping');
 if([...body.querySelectorAll('.set-card-head strong')].some(n=>n.textContent==='Agent')) throw Error('duplicate Agent card');
 if(document.querySelector('.settings-nav').textContent.includes('Tool calls')) throw Error('empty tools page still in the navigation');
 setView({settingsSection:'code'}); await wait(100);
 body=document.querySelector('.settings-body');
 if(!body.textContent.includes('Code Intelligence') || body.textContent.includes('Sub-agent') || body.textContent.includes('Vision') || body.textContent.includes('Auto Memory')) throw Error('code intelligence grouping');
 setView({settingsSection:'agent'}); await wait(100);
 body=document.querySelector('.settings-body');
 if(!body.textContent.includes('Sub-agent') || !body.textContent.includes('Vision Assistant') || !body.textContent.includes('Auto Memory')) throw Error('assistants grouping');
 setView({settingsSection:'safety'}); await wait(100);
 body=document.querySelector('.settings-body');
 if(!body.textContent.includes('Desktop popup when a task ends') || !body.textContent.includes('Browser notification when a task ends')) throw Error('notifications grouping');
 render(null,checks);
 const items=[{kind:'user',id:'u1',ts:1,text:'test',images:[]},{kind:'assistant',id:'a1',ts:2,model:'test',blocks:[{type:'toolCall',id:'c1',name:'read',args:{path:'doc.md'}}]},{kind:'toolResult',ts:3,toolCallId:'c1',toolName:'read',text:'# Read result',images:[],isError:false}];
 setView({processDefault:'expanded'});
 set({items,snap:{active:true,cwd:'C:/test',flags:{},session:{id:'test'},run:{startedAt:Date.now()}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],models:[]});
 render(h(Transcript,{}),document.getElementById('app')); await wait(350);
 if(document.querySelector('.summary-head').getAttribute('aria-expanded')!=='true') throw Error('default not expanded');
 document.querySelector('.action-row').click(); await wait(350);
 if(!document.querySelector('.raw')) throw Error('child not expanded');
 set({snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'}},items:[...items,{kind:'assistant',id:'final',ts:4,model:'test',blocks:[{type:'text',text:'Done'}],stopReason:'stop'},{kind:'runChanges',id:'card',runId:1,ts:5,files:[{path:'doc.md',additions:1,deletions:1}]}]}); await wait(350);
 if(document.querySelector('.summary-head').getAttribute('aria-expanded')!=='true' || !document.querySelector('.raw')) throw Error('completion reset expansion');
 document.querySelector('.change-file').click(); await wait(700);
 if(!document.querySelector('.md-diff h1') || document.querySelector('.change-diff-bar')) throw Error('Markdown not automatic');
 document.querySelector('.summary-head').click(); await wait(400);
 setView({processDefault:'collapsed'}); setView({processDefault:'expanded'}); await wait(350);
 if(document.querySelector('.summary-head').getAttribute('aria-expanded')!=='false') throw Error('user fold overwritten');
 {const app=document.getElementById('app'); app.style.cssText='height:420px;display:flex;flex-direction:column';
  set({snap:{active:false,cwd:'C:/test',flags:{},session:{id:'scroll'}},items:[{kind:'user',id:'u9',ts:1,text:'t',images:[]},{kind:'assistant',id:'a9',ts:2,model:'test',blocks:[{type:'text',text:'line\\n\\n'.repeat(60)}],stopReason:'stop'},{kind:'runChanges',id:'card9',runId:9,ts:3,files:[{path:'a.ts',additions:60,deletions:0}]}]}); await wait(600);
  const sc=document.querySelector('.transcript');
  if(sc.scrollHeight-sc.clientHeight-sc.scrollTop>10) throw Error('not at bottom');
  const row=document.querySelector('.transcript .change-file'); const top0=row.getBoundingClientRect().top;
  row.click(); await wait(1200);
  if(!document.querySelector('.transcript .change-diff')) throw Error('diff missing');
  if(Math.abs(row.getBoundingClientRect().top-top0)>1) throw Error('file row moved when its diff opened: '+(row.getBoundingClientRect().top-top0));
  if(sc.scrollHeight-sc.clientHeight-sc.scrollTop<100) throw Error('diff did not grow downwards');
  app.style.cssText='';
 }
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "UI upgrades",
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
