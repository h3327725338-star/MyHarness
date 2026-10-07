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
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
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
 const localText='[report](C:/Docs/report.pptx)\\n\\nreport.pptx missing.txt\\n\\n\\x60C:/Docs/My report.pptx\\x60';
 render(h(Markdown,{text:localText}),app); await wait(600);
 const links=app.querySelectorAll('[data-local-path]');
 if(links.length!==3) throw Error('local links missing: '+links.length);
 links[0].click(); await wait(100);
 links[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})); await wait(300);
 const menu=document.querySelector('.local-file-menu');
 if(!menu || menu.querySelectorAll('button').length!==3) throw Error('main menu not compact');
 if(menu.textContent.includes('Installed Editor')) throw Error('handlers flattened');
 if(getComputedStyle(menu).position!=='fixed' || parseFloat(getComputedStyle(menu).borderRadius)<8) throw Error('desktop styling absent');
 const branches=[...menu.querySelectorAll('[aria-haspopup]')];
 branches[0].dispatchEvent(new PointerEvent('pointerenter')); await wait(50);
 let child=document.querySelector('.local-file-submenu');
 if(!child || child.querySelectorAll('button').length!==2) throw Error('copy submenu absent');
 branches[1].dispatchEvent(new PointerEvent('pointerenter')); await wait(50);
 child=document.querySelector('.local-file-submenu');
 if(!child || !child.textContent.includes('Installed Editor')) throw Error('discovered handler absent');
 const parentRect=menu.getBoundingClientRect(), childRect=child.getBoundingClientRect();
 if(childRect.left<parentRect.right || childRect.right>innerWidth) throw Error('submenu positioning');
 branches[1].focus(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 if(!child.contains(document.activeElement)) throw Error('keyboard did not enter submenu');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
 if(document.querySelector('.local-file-submenu') || document.activeElement!==branches[1]) throw Error('keyboard did not return');
 branches[1].click();
 child=document.querySelector('.local-file-submenu');
 [...child.querySelectorAll('button')].find(b=>b.textContent.includes('Installed Editor')).click(); await wait(100);
 if(document.querySelector('.local-file-menu')) throw Error('menu not dismissed');
 links[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20})); await wait(300);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 if(document.querySelector('.local-file-menu')) throw Error('Escape did not dismiss');
 links[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-12,clientY:innerHeight-12})); await wait(300);
 const edgeMenu=document.querySelector('.local-file-menu');
 edgeMenu.querySelectorAll('[aria-haspopup]')[1].dispatchEvent(new PointerEvent('pointerenter')); await wait(50);
 const edgeChild=document.querySelector('.local-file-submenu');
 const edgeRect=edgeChild.getBoundingClientRect();
 if(edgeRect.left<0 || edgeRect.right>innerWidth || edgeRect.bottom>innerHeight || edgeRect.right>edgeMenu.getBoundingClientRect().left) throw Error('edge submenu not flipped/clamped');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 if(document.querySelector('.local-file-submenu') || !document.querySelector('.local-file-menu')) throw Error('Escape must close one level');
 document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
 if(document.querySelector('.local-file-menu')) throw Error('outside click did not dismiss');
 if(renderMarkdown('[unsafe](javascript:alert(1))').includes('javascript:')) throw Error('unsafe URL');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.stack;document.body.append(p);}
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.route("POST", "/api/files/local", ({ body }) => {
				const payload = body as { path: string; action: string; handler?: string };
				if (payload.path.includes("missing")) throw new Error("missing file");
				if (payload.action === "handler" && payload.handler !== "installed-editor")
					throw new Error("wrong handler");
				return {
					path: "C:/Docs/report.pptx",
					directory: false,
					choices: [{ id: "installed-editor", label: "Installed Editor" }],
				};
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "User message line breaks",
				isSolved: (p) => p.text.includes('id="ready">'),
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
