import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
// The empty input box's placeholder (composer.js → draft-editor.js data-placeholder / data-placeholder-short,
// composer.css @container composer-input): in a narrow box (collaboration column, panel at its widest) the short
// form is shown, so the "/ commands · @ files · ! shell" hints are never cut off, in English and Chinese alike.
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps the composer placeholder whole at narrow input widths in en and zh-CN",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-composer-placeholder-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {DraftEditor} from '/js/draft-editor.js';
import {t} from '/js/i18n.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const app=document.getElementById('app');
const WIDTHS=[354,460,700];
const out=[];
const draw=()=>render(h('div',{},WIDTHS.map(w=>h('div',{key:w,style:{width:w+'px',marginBottom:'12px'}},h(DraftEditor,{value:'',class:'composer-input',
 placeholder:t('Ask MyHarness to work on something…  / commands · @ files · ! shell'),
 placeholderShort:t('Ask MyHarness…  / commands · @ files · ! shell'),onChange:()=>{}})))),app);
try {
 for(const lang of ['en','zh-CN']){
  setLang(lang);render(null,app);draw();await wait(150);
  const boxes=[...document.querySelectorAll('.composer-input')];
  check(boxes.length===WIDTHS.length,'expected '+WIDTHS.length+' input boxes, got '+boxes.length);
  for(const el of boxes){
   const cs=getComputedStyle(el,'::before');
   const text=cs.content.replace(/^"|"$/g,'');
   const c=document.createElement('canvas').getContext('2d');
   c.font=(cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily).replace(/\\s+/g,' ').trim();
   const need=c.measureText(text).width;
   const room=el.getBoundingClientRect().width-4;
   out.push({lang,w:Math.round(el.getBoundingClientRect().width),need:Math.round(need),room:Math.round(room),text});
   check(text.includes('/')&&text.includes('@')&&text.includes('!'),lang+': the placeholder lost its hints: '+text);
   check(need<=room+0.5,lang+' at '+Math.round(room+4)+'px: the placeholder is cut ("'+text+'" needs '+Math.round(need)+'px)');
  }
  // A wide box keeps the full sentence.
  const wide=getComputedStyle(boxes[boxes.length-1],'::before').content;
  check(wide.includes(t('Ask MyHarness to work on something…  / commands · @ files · ! shell')),lang+': the wide box does not show the full placeholder: '+wide);
 }
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed '+JSON.stringify(out)+'</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+' '+JSON.stringify(out)+'</p>'); }
`,
			);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Composer placeholder test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90_000,
);
