import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
const MODEL_ID = "openrouter/zai-org/glm-4.6-very-long-model-identifier-for-test:high";
const models = {
	providers: [
		{
			id: "openrouter",
			name: "OpenRouter",
			models: [
				{
					id: MODEL_ID,
					name: MODEL_ID,
					reasoning: true,
					thinkingLevels: ["low", "high"],
				},
			],
		},
	],
};

const items = [
	{
		id: "autoCompact",
		section: "Agent",
		label: "Auto-compact context",
		description: "Compact the conversation automatically when the context window is almost full.",
		type: "boolean",
		value: true,
	},
	{
		id: "compactionModel",
		section: "Agent",
		label: "Compaction model",
		description: "Model used to summarize context.",
		type: "modelRef",
		value: { provider: "openrouter", model: MODEL_ID },
	},
	{
		id: "fallbackModel",
		section: "Agent",
		label: "Fallback model",
		description: "Takes over when the main model keeps failing.",
		type: "modelRef",
		value: { provider: "openrouter", model: MODEL_ID, thinkingLevel: "high", enabled: true },
		note: "enabled",
	},
	{
		id: "conversationNaming",
		section: "Assistants",
		label: "Conversation naming",
		description: "Name automatically.",
		type: "modelRef",
		value: { provider: "openrouter", model: MODEL_ID, enabled: true },
		note: "enabled",
	},
	{
		id: "autoMemory",
		section: "Assistants",
		label: "Auto Memory",
		description: "Save memory after each task.",
		type: "modelRef",
		value: { provider: "openrouter", model: MODEL_ID, enabled: true },
		note: "enabled",
	},
	{
		id: "subAgent",
		section: "Assistants",
		label: "Sub-agents (Explore)",
		description: "Allow the agent to delegate read-only investigation to sub-agents.",
		type: "modelRef",
		value: { provider: "openrouter", model: MODEL_ID, enabled: true, maxTasks: 3, mode: "read-only" },
		note: "enabled",
		modeSelect: {
			options: [
				{ value: "read-only", label: "Read only" },
				{ value: "read-write", label: "Read & write" },
			],
		},
		inlineNumber: { min: 1, max: 18 },
	},
	{
		id: "visionAssistant",
		section: "Assistants",
		label: "Vision assistant",
		description: "Use a model for image analysis.",
		type: "modelRef",
		value: { provider: "openrouter", model: MODEL_ID, enabled: true },
		note: "enabled",
	},
];

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders complete model IDs in modelRef controls and menus in both locales",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-modelref-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/settings", () => ({ items }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(ok,message)=>{if(!ok)throw Error(message)};
const app=document.getElementById('app');
const modelRows=()=>[...document.querySelectorAll('.set-row')].filter(row=>row.querySelector('.model-ref-btn'));
const rowFor=needle=>modelRows().find(row=>row.querySelector('.set-label')?.textContent.includes(needle));
const checkButton=row=>{
 const button=row.querySelector('.model-ref-btn');
 const text=row.querySelector('.model-ref-text');
 assert(button&&text,'model button or text is missing');
 assert(button.textContent===${JSON.stringify(MODEL_ID)},'button text is not the complete model ID: '+button.textContent);
 assert(button.title===${JSON.stringify(MODEL_ID)},'button title is not the complete model ID: '+button.title);
 const style=getComputedStyle(text);
 assert(style.textOverflow!=='ellipsis'&&style.whiteSpace==='normal'&&style.overflowWrap==='anywhere','model text still uses truncation styles');
 assert(text.scrollWidth<=text.clientWidth+1,'model text overflows horizontally: '+text.textContent);
 assert(button.scrollWidth<=button.clientWidth+1,'model button clips its text: '+text.textContent);
 // offsetHeight, not getBoundingClientRect: the dialog entrance animation scales the whole modal, and a stalled
 // animation clock in headless browsers can freeze that scale mid-flight, resampling every rect inside the dialog
 // (31.99 instead of 32). offsetHeight measures layout height only, which is what this assertion is about.
  assert(button.offsetHeight>=32,'model button has no adaptive height');
};
const checkMenu=async row=>{
 const button=row.querySelector('.model-ref-btn');
 button.click();await wait(150);
 const pop=document.querySelector('.model-ref-pop');
 assert(pop,'model reference popover did not open');
 const option=pop.querySelector('.model-row-name');
 assert(option&&option.textContent===${JSON.stringify(MODEL_ID)},'popover option is not complete: '+option?.textContent);
 const style=getComputedStyle(option);
 assert(!option.classList.contains('truncate')&&style.textOverflow!=='ellipsis'&&style.whiteSpace==='normal','popover option still truncates');
 assert(option.scrollWidth<=option.clientWidth+1,'popover option overflows horizontally: '+option.textContent);
 button.click();await wait(150);
};
try {
 document.documentElement.dataset.motion='off';
 set({lang:'zh-CN',models:${JSON.stringify(models)},settings:{items:${JSON.stringify(items)}},snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'},thinking:{supported:false}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],items:[]});
 for(const locale of ['zh-CN','en']){
  // The live app rebuilds its root on a language change (main.js keys App by view.lang); remount here for the same effect.
  render(null,app);
  setView({lang:locale,settingsSection:'agent'});
  render(h(SettingsModal,{}),app);await wait(250);
  const expected=locale==='zh-CN'?['压缩模型','备用模型','子智能体']:['Compaction model','Fallback model','Sub-agents'];
  const rows=expected.map(label=>rowFor(label));
  if(rows.some(row=>!row))throw Error('missing modelRef row in '+locale+': '+expected.join(', '));
  if(modelRows().length!==6)throw Error('expected six modelRef rows in '+locale+', got '+modelRows().length);
  for(const row of rows) {
   assert(row.classList.contains('wide'),'modelRef row is not wide: '+row.querySelector('.set-label')?.textContent);
   checkButton(row);
  }
  const rights=[...document.querySelectorAll('.set-row')].map(row=>Math.round(row.querySelector('.set-control').getBoundingClientRect().right));
  if(new Set(rights).size!==1)throw Error('settings row right edges differ in '+locale+': '+rights.join(','));
  await checkMenu(rows[1]);
 }
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Settings model reference test",
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
