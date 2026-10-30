import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"selects, persists and reloads color themes separately for each chat mode",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		if (!artifacts) throw new Error("MYHARNESS_ARTIFACTS_DIR is required for browser test output");
		const tests = join(artifacts, "tests");
		mkdirSync(tests, { recursive: true });
		const root = mkdtempSync(join(tests, "color-theme-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/settings", () => ({ items: [] }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><script src="/js/boot-theme.js"></script><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {set,setView,state} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const pickSelect=async(triggerSelector,optionText)=>{const trigger=document.querySelector(triggerSelector);if(!trigger)throw Error('select trigger missing: '+triggerSelector);trigger.click();await wait(350);const options=[...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')];const hit=options.find(el=>el.textContent.trim()===optionText);if(!hit)throw Error('select option missing: '+optionText);hit.click();await wait(200);};
const palette=()=>getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim();
const checkSwitch=(coding,general)=>{
 const css=getComputedStyle(document.documentElement);
 if(css.getPropertyValue('--mode-coding').trim()!==coding||css.getPropertyValue('--mode-general').trim()!==general) throw Error('switch colors do not match saved schemes');
};
const newTokens=['--r-2xs','--border-soft','--border-hover','--fs-body','--fs-mini','--fs-title-xs','--fs-title-sm','--ease-out','--t-pop','--t-close','--t-morph','--shadow-toggle','--shadow-mode-well','--shadow-mode-knob'];
const checkNewTokens=(label)=>{const css=getComputedStyle(document.documentElement);const empty=newTokens.filter(n=>!css.getPropertyValue(n).trim());if(empty.length)throw Error('empty new tokens under '+label+': '+empty.join(','));};
try {
 const prefs=JSON.parse(localStorage.getItem('myharness.web.prefs')||'{}');
 if(prefs.colorThemes?.coding==='forest' && prefs.colorThemes?.general==='amber') {
  if(document.documentElement.dataset.colorTheme!=='forest'||state.view.colorTheme!=='forest'||palette()!=='#292e2b') throw Error('reload lost Coding theme');
  checkSwitch('#a7c080','#d4ae82');
  checkNewTokens('dark forest (reload)');
  setView({chatMode:'general'});await wait(30);checkSwitch('#a7c080','#d4ae82');if(palette()!=='#302b28'||state.view.colorTheme!=='amber') throw Error('reload lost General theme');
  checkNewTokens('dark amber (reload)');
 } else {
  set({settings:{items:[]}});
  setView({theme:'dark',chatMode:'coding',lang:'zh-CN',motion:'off',settingsSection:'appearance'});
  render(h(SettingsModal,{}),document.getElementById('app'));await wait(200);
  const names={classic:'经典炭黑',forest:'静谧森林',amber:'暖夜琥珀'};
  let trigger=document.querySelector('button.select-like[aria-label="配色主题"]');
  if(!trigger) throw Error('missing theme trigger');
  trigger.click();await wait(350);
  const choices=[...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')].map(o=>o.textContent.trim()).join('|');
  trigger.click();await wait(250);
  if(choices!=='经典炭黑|静谧森林|暖夜琥珀') throw Error('missing theme choices');
  const rows=[...document.querySelectorAll('.set-row')];
  if(!rows.at(-1).textContent.includes('配色主题')||!rows.at(-2).textContent.includes('阅读宽度')) throw Error('wrong placement');
  for(const [scheme,color] of [['classic','#1c1d1d'],['forest','#292e2b'],['amber','#302b28']]) {
   await pickSelect('button.select-like[aria-label="配色主题"]',names[scheme]);await wait(50);
   if(palette()!==color||JSON.parse(localStorage.getItem('myharness.web.prefs')).colorThemes.coding!==scheme) throw Error('theme not applied/persisted '+scheme);
   checkNewTokens('dark '+scheme);
   // General has not been picked yet, so it shows its default, Quiet Forest.
   const accent={classic:'#79a8f5',forest:'#a7c080',amber:'#d4ae82'}[scheme];checkSwitch(accent,'#a7c080');
   setView({chatMode:'general'});await wait(30);checkSwitch(accent,'#a7c080');if(palette()!=='#292e2b'||state.view.colorTheme!=='forest') throw Error('Coding modified General');
   setView({chatMode:'coding'});await wait(30);if(palette()!==color||state.view.colorTheme!==scheme) throw Error('Coding theme not restored');
  }
  setView({chatMode:'general',colorTheme:'forest'});await wait(30);checkSwitch('#d4ae82','#a7c080');
  // Light display has the same schemes: General is on Quiet Forest and Coding on Warm Amber from the steps above.
  setView({theme:'light'});await wait(30);checkSwitch('#96632b','#47773a');if(palette()!=='#f0f4eb') throw Error('light Quiet Forest not applied');
  checkNewTokens('light forest');
  setView({chatMode:'coding'});await wait(30);checkSwitch('#96632b','#47773a');if(palette()!=='#f8f2e8') throw Error('light Warm Amber not applied');
  checkNewTokens('light amber');
  setView({colorTheme:'classic'});await wait(30);checkSwitch('#2c66d6','#47773a');if(palette()!=='#fbfbfa') throw Error('light Classic changed');
  checkNewTokens('light classic');
  setView({theme:'dark',chatMode:'general',colorTheme:'amber'});
  setView({chatMode:'coding',colorTheme:'forest'});location.reload();await new Promise(()=>{});
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
				label: "Color theme settings test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	60000,
);
