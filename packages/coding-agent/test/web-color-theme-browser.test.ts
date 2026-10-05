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
const palette=()=>getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim();
const checkSwitch=(coding,general)=>{
 const css=getComputedStyle(document.documentElement);
 if(css.getPropertyValue('--mode-coding').trim()!==coding||css.getPropertyValue('--mode-general').trim()!==general) throw Error('switch colors do not match saved schemes');
};
try {
 const prefs=JSON.parse(localStorage.getItem('myharness.web.prefs')||'{}');
 if(prefs.colorThemes?.coding==='forest' && prefs.colorThemes?.general==='amber') {
  if(document.documentElement.dataset.colorTheme!=='forest'||state.view.colorTheme!=='forest'||palette()!=='#292e2b') throw Error('reload lost Coding theme');
  checkSwitch('#a7c080','#d4ae82');
  setView({chatMode:'general'});await wait(30);checkSwitch('#a7c080','#d4ae82');if(palette()!=='#302b28'||state.view.colorTheme!=='amber') throw Error('reload lost General theme');
 } else {
  set({settings:{items:[]}});
  setView({theme:'dark',chatMode:'coding',lang:'zh-CN',motion:'off',settingsSection:'appearance'});
  render(h(SettingsModal,{}),document.getElementById('app'));await wait(200);
  let select=document.querySelector('select[aria-label="配色主题"]');
  if(!select||[...select.options].map(o=>o.textContent).join('|')!=='经典炭黑|静谧森林|暖夜琥珀') throw Error('missing theme choices');
  const rows=[...document.querySelectorAll('.set-row')];
  if(!rows.at(-1).textContent.includes('配色主题')||!rows.at(-2).textContent.includes('阅读宽度')) throw Error('wrong placement');
  for(const [scheme,color] of [['classic','#1c1d1d'],['forest','#292e2b'],['amber','#302b28']]) {
   select=document.querySelector('select[aria-label="配色主题"]');select.value=scheme;select.dispatchEvent(new Event('change',{bubbles:true}));await wait(50);
   if(palette()!==color||JSON.parse(localStorage.getItem('myharness.web.prefs')).colorThemes.coding!==scheme) throw Error('theme not applied/persisted '+scheme);
   const accent={classic:'#79a8f5',forest:'#a7c080',amber:'#d4ae82'}[scheme];checkSwitch(accent,'#79a8f5');
   setView({chatMode:'general'});await wait(30);checkSwitch(accent,'#79a8f5');if(palette()!=='#1c1d1d'||state.view.colorTheme!=='classic') throw Error('Coding modified General');
   setView({chatMode:'coding'});await wait(30);if(palette()!==color||state.view.colorTheme!==scheme) throw Error('Coding theme not restored');
  }
  setView({chatMode:'general',colorTheme:'forest'});await wait(30);checkSwitch('#d4ae82','#a7c080');
  setView({theme:'light'});await wait(30);checkSwitch('#2c66d6','#2c66d6');if(palette()!=='#fbfbfa') throw Error('light palette changed');
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
