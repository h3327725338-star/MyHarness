import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"hides the draft placeholder during IME composition and restores it on cancellation",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		const base = artifacts ? join(artifacts, "tests") : tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "draft-ime-"));
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
import {useState} from '/vendor/preact-hooks.js';
const changes=[];
let clear;
function App() {
 const [value,setValue]=useState('');
 clear=()=>setValue('');
 return h(DraftEditor,{value,class:'composer-input',placeholder:'Ask MyHarness',onChange:(text)=>{changes.push(text);setValue(text);}});
}
render(h(App),document.getElementById('app'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,100));
const check=(condition,message)=>{if(!condition) throw Error(message);};
const placeholder=el=>getComputedStyle(el,'::before').content;
try {
 await tick();
 const el=document.querySelector('.draft'); el.focus(); await tick();
 check(placeholder(el).includes('Ask MyHarness'),'initial placeholder missing');
 el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 check(!placeholder(el).includes('Ask MyHarness'),'placeholder visible at composition start');
 el.firstElementChild.textContent='zhong';
 el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'zhong',isComposing:true}));
 check(!placeholder(el).includes('Ask MyHarness'),'placeholder overlaps preedit text');
 check(changes.length===0,'uncommitted text reported as draft');
 el.firstElementChild.innerHTML='<br>';
 el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));
 await tick();
 check(placeholder(el).includes('Ask MyHarness'),'placeholder not restored after cancellation');
 check(changes.length===0,'cancellation changed draft');
 el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 el.firstElementChild.textContent='中文';
 el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'中文',isComposing:true}));
 el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
 await tick();
 check(changes.join('|')==='中文','committed Chinese text not preserved');
 check(el.textContent==='中文','committed text duplicated');
 check(!placeholder(el).includes('Ask MyHarness'),'placeholder visible after commit');
 clear();
 await tick();
 check(placeholder(el).includes('Ask MyHarness'),'placeholder not restored after clearing draft');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>'); }
`,
			);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Draft IME regression test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	90_000,
);
