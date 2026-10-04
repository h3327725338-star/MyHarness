import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"displays user messages on separate lines without changing normal Markdown",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "message-markdown-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installed[0]!.kind, rootDir: join(root, "browser") });
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/markdown/", directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(join(root, "index.html"), '<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>');
			writeFileSync(join(root, "test.js"), `
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {Markdown,renderMarkdown} from '/js/markdown.js';
import {set} from '/js/store.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const text='在吗?\\n在吗?\\n在吗?';
 if(renderMarkdown(text).includes('<br>')) throw Error('normal Markdown changed');
 set({snap:{active:false,cwd:'C:/test',flags:{},session:{id:'test'},thinking:{supported:false}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],items:[{kind:'user',id:'u',ts:1,text,images:[]}]});
 render(h(Transcript,{}),app);await wait(100);
 const p=app.querySelector('.user-text p');
 if(p.querySelectorAll('br').length!==2) throw Error('missing user breaks');
 const tops=[...p.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>{const r=document.createRange();r.selectNodeContents(n);return r.getBoundingClientRect().top;});
 if(tops.length!==3||!(tops[0]<tops[1]&&tops[1]<tops[2])) throw Error('not three visible lines');
 if(renderMarkdown(text).includes('<br>')) throw Error('cache modes mixed');
 render(h(Markdown,{text}),app);
 render(h(Markdown,{text,breaks:true}),app);
 if(app.querySelectorAll('br').length!==2) throw Error('prop update missed');
 render(h(Markdown,{text}),app);
 if(app.querySelector('br')) throw Error('normal mode not restored');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.stack;document.body.append(p);}
`);
			server.route("GET", "/hold", async () => { await new Promise((resolve) => setTimeout(resolve, 12_000)); return {}; });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({ url: `http://127.0.0.1:${port}/`, readySelector: "#ready", label: "User message line breaks", isSolved: (p) => p.text.includes('id="ready">') });
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90_000,
);
