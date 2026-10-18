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
import {set,state} from '/js/store.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=(cond,timeoutMs=8000,stepMs=25)=>new Promise((resolve,reject)=>{const start=Date.now();const poll=async()=>{for(;;){try{if(cond())return resolve();}catch(e){}if(Date.now()-start>=timeoutMs)return reject(Error('waitFor timeout after '+timeoutMs+'ms: waiting for '+String(cond)));await wait(stepMs);}};poll();});
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
 render(h(Markdown,{text:localText}),app);
 await waitFor(()=>app.querySelectorAll('[data-local-path]').length===3);
 const links=app.querySelectorAll('[data-local-path]');
 if(links.length!==3) throw Error('local links missing: '+links.length);
 links[0].click();
 await waitFor(()=>state.view.wsActive==='file:C:/Docs/report.pptx');
 if(!state.view.panelOpen || document.querySelector('.local-file-menu')) throw Error('left click must open the file in the right-hand workspace, without a menu');
 if(!state.view.wsTabs.some(t=>t.id==='file:C:/Docs/report.pptx')) throw Error('file tab missing');
 links[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}));
 await waitFor(()=>{const m=document.querySelector('.local-file-menu');return !!m&&m.querySelectorAll('button').length===3;});
 const menu=document.querySelector('.local-file-menu');
 if(!menu || menu.querySelectorAll('button').length!==3) throw Error('main menu not compact');
 if(menu.textContent.includes('Installed Editor')) throw Error('handlers flattened');
 if(getComputedStyle(menu).position!=='fixed' || parseFloat(getComputedStyle(menu).borderRadius)<8) throw Error('desktop styling absent');
 const branches=[...menu.querySelectorAll('[aria-haspopup]')];
 branches[0].dispatchEvent(new PointerEvent('pointerenter'));
 await waitFor(()=>{const c=document.querySelector('.local-file-submenu');return !!c&&c.querySelectorAll('button').length===2;});
 let child=document.querySelector('.local-file-submenu');
 if(!child || child.querySelectorAll('button').length!==2) throw Error('copy submenu absent');
 branches[1].dispatchEvent(new PointerEvent('pointerenter'));
 await waitFor(()=>{const c=document.querySelector('.local-file-submenu');return !!c&&c.textContent.includes('Installed Editor');});
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
 [...child.querySelectorAll('button')].find(b=>b.textContent.includes('Installed Editor')).click();
 await waitFor(()=>!document.querySelector('.local-file-menu'));
 if(document.querySelector('.local-file-menu')) throw Error('menu not dismissed');
 links[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}));
 await waitFor(()=>document.querySelector('.local-file-menu'));
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await waitFor(()=>!document.querySelector('.local-file-menu'));
 if(document.querySelector('.local-file-menu')) throw Error('Escape did not dismiss');
 links[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-12,clientY:innerHeight-12}));
 await waitFor(()=>{const m=document.querySelector('.local-file-menu');return !!m&&m.querySelectorAll('[aria-haspopup]').length===2;});
 const edgeMenu=document.querySelector('.local-file-menu');
 edgeMenu.querySelectorAll('[aria-haspopup]')[1].dispatchEvent(new PointerEvent('pointerenter'));
 await waitFor(()=>document.querySelector('.local-file-submenu'));
 const edgeChild=document.querySelector('.local-file-submenu');
 const edgeRect=edgeChild.getBoundingClientRect();
 if(edgeRect.left<0 || edgeRect.right>innerWidth || edgeRect.bottom>innerHeight || edgeRect.right>edgeMenu.getBoundingClientRect().left) throw Error('edge submenu not flipped/clamped');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 if(document.querySelector('.local-file-submenu') || !document.querySelector('.local-file-menu')) throw Error('Escape must close one level');
 document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
 await waitFor(()=>!document.querySelector('.local-file-menu'));
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

const installedPatch = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installedPatch.length)(
	"renders *** Begin Patch blocks as one diff code block",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "patch-markdown-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installedPatch[0]!.kind, rootDir: join(root, "browser") });
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
				'<!doctype html><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script src="/markdown/highlight.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Markdown,renderMarkdown} from '/js/markdown.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const full='*** Begin Patch\\n*** Update File: a.ts\\n@@ -1,2 +1,2 @@\\n- old\\n+ new\\n*** End of File\\n*** End Patch\\n\\n说明文字';
 const html=renderMarkdown(full);
 if(/<[uo]l[ >]/i.test(html) || /<li[ >]/i.test(html)) throw Error('patch rendered as list: '+html);
 if(!/class="code-block"[\\s\\S]*Begin Patch[\\s\\S]*End Patch/.test(html)) throw Error('patch not in code block: '+html);
 if(!/<p>说明文字<\\/p>/.test(html)) throw Error('trailing text not a paragraph: '+html);
 if(!/class="code-lang">diff<\\/span>/.test(html)) throw Error('patch language not diff: '+html);
 render(h(Markdown,{text:full}),app); await wait(300);
 if(app.querySelector('ul,li')) throw Error('DOM has list elements');
 const code=app.querySelector('.code-block code');
 if(!code || !code.textContent.includes('*** Begin Patch') || !code.textContent.includes('*** End Patch')) throw Error('DOM code block missing patch');
 if(code.textContent.includes('\\u0060\\u0060\\u0060')) throw Error('wrapper fence leaked into code: '+code.textContent);
 const paras=[...app.querySelectorAll('.md > p')].map(p=>p.textContent);
 if(!paras.includes('说明文字')) throw Error('DOM trailing paragraph missing: '+JSON.stringify(paras));
 render(h(Markdown,{text:full,breaks:true}),app); await wait(100);
 if(app.querySelector('ul,li')) throw Error('breaks mode regressed to list');
 if(!app.querySelector('.code-block code').textContent.includes('*** End Patch')) throw Error('breaks mode lost patch');
 const stream='*** Begin Patch\\n*** Update File: a.ts\\n@@ -1,2 +1,2 @@\\n- old\\n+ new';
 render(h(Markdown,{text:stream}),app); await wait(100);
 if(app.querySelector('ul,li')) throw Error('streaming patch rendered as list');
 if(!app.querySelector('.code-block code').textContent.includes('*** Begin Patch')) throw Error('streaming patch not a code block');
 const fenced='\\u0060\\u0060\\u0060text\\n*** Begin Patch\\n- old\\n*** End Patch\\n\\u0060\\u0060\\u0060';
 render(h(Markdown,{text:fenced}),app); await wait(100);
 const blocks=app.querySelectorAll('.code-block');
 if(blocks.length!==1) throw Error('fenced patch wrapped again: '+blocks.length);
 if(blocks[0].querySelector('.code-lang').textContent!=='text') throw Error('fenced language changed');
 const list='- a\\n- b';
 render(h(Markdown,{text:list}),app); await wait(100);
 if(!app.querySelector('ul')) throw Error('ordinary list broken');
 const hr='前言\\n\\n***\\n\\n后记';
 render(h(Markdown,{text:hr}),app); await wait(100);
 if(!app.querySelector('hr')) throw Error('thematic break broken');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.stack;document.body.append(p);}
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Patch code block",
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

const installedAutolink = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installedAutolink.length)(
	"does not autolink blocklisted local file names but keeps explicit and non-blocklisted links",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "autolink-blocklist-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installedAutolink[0]!.kind, rootDir: join(root, "browser") });
		const probed: string[] = [];
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
				'<!doctype html><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script src="/markdown/highlight.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Markdown} from '/js/markdown.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=(cond,timeoutMs=8000,stepMs=25)=>new Promise((resolve,reject)=>{const start=Date.now();const poll=async()=>{for(;;){try{if(cond())return resolve();}catch(e){}if(Date.now()-start>=timeoutMs)return reject(Error('waitFor timeout after '+timeoutMs+'ms: waiting for '+String(cond)));await wait(stepMs);}};poll();});
try {
 const B='\\x60';
 const lines=['foo.ts','README.md','package.json','main.py','build.sh','src/utils/index.ts','./a.json','C:/dir/file.md',B+'foo.ts'+B,B+'README.md'+B,B+'package.json'+B,B+'main.py'+B,B+'build.sh'+B,B+'src/utils/index.ts'+B,B+'./a.json'+B,B+'C:/dir/file.md'+B,'https://example.md/page','[t](https://x.y)','www.example.com','[report](C:/Docs/report.pptx)','report.pptx',B+'C:/Docs/My report.pptx'+B,'[x](C:/a/b.ts)'];
 const text=lines.join('\\n\\n');
 render(h(Markdown,{text}),app);
 await waitFor(()=>app.querySelectorAll('[data-local-path]').length===4);
 const locals=[...app.querySelectorAll('[data-local-path]')];
 if(locals.length!==4) throw Error('local count: '+locals.length+' '+locals.map(a=>a.textContent).join('|'));
 const localTexts=locals.map(a=>a.textContent);
 if(localTexts.join('|')!=='report|report.pptx|C:/Docs/My report.pptx|x') throw Error('local texts: '+localTexts.join('|'));
 if(locals[0].getAttribute('data-local-path')!=='C:/Docs/report.pptx') throw Error('explicit report path');
 if(locals[3].getAttribute('data-local-path')!=='C:/a/b.ts') throw Error('explicit ts still local');
 const webs=[...app.querySelectorAll('a')].filter(a=>!a.hasAttribute('data-local-path'));
 if(webs.length!==3) throw Error('web count: '+webs.length+' '+webs.map(a=>a.textContent).join('|'));
 const hrefs=webs.map(a=>a.getAttribute('href'));
 if(hrefs[0]!=='https://example.md/page') throw Error('https md href: '+hrefs[0]);
 if(hrefs[1]!=='https://x.y' || webs[1].textContent!=='t') throw Error('explicit web broken');
 if(hrefs[2]!=='http://www.example.com' || webs[2].textContent!=='www.example.com') throw Error('www broken: '+hrefs[2]);
 const blocked=['foo.ts','README.md','package.json','main.py','build.sh','src/utils/index.ts','./a.json','C:/dir/file.md'];
 for(const b of blocked){ if([...app.querySelectorAll('a')].some(a=>a.textContent===b)) throw Error('blocked became link: '+b); }
 const codes=[...app.querySelectorAll('code')];
 for(const b of blocked){ const c=codes.find(x=>x.textContent===b); if(!c) throw Error('code missing: '+b); if(c.querySelector('a')) throw Error('blocked code linked: '+b); }
 const allowedCode=codes.find(x=>x.textContent==='C:/Docs/My report.pptx');
 if(!allowedCode || !allowedCode.querySelector('a[data-local-path]')) throw Error('allowed code not linked');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.stack;document.body.append(p);}
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.route("POST", "/api/files/local", ({ body }) => {
				const payload = body as { path: string; action: string };
				if (payload.action === "resolve" && typeof payload.path === "string") probed.push(payload.path);
				return { path: payload.path, directory: false, choices: [] };
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Autolink blocklist",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			expect(probed.sort()).toEqual(["C:/Docs/My report.pptx", "report.pptx"]);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90_000,
);

const installedCodespan = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installedCodespan.length)(
	"escapes HTML inside inline code spans",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "codespan-escape-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installedCodespan[0]!.kind, rootDir: join(root, "browser") });
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
				'<!doctype html><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Markdown} from '/js/markdown.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const B='\\x60';
 const payloads=['<img src=x onerror="window.__xss=1">','<script>window.__xss=2</script>','<svg onload="window.__xss=3">','<a href="javascript:window.__xss=4">x</a>','&amp;','a & b','"q"','</code><b>bold</b>'];
 window.__xss=undefined;
 render(h(Markdown,{text:payloads.map(p=>B+p+B).join('\\n\\n')}),app); await wait(300);
 const bad=app.querySelector('.md img,.md svg,.md script,.md iframe,.md form,.md b,.md [onerror],.md [onload],.md [onclick],.md a[href^="javascript:"]');
 if(bad) throw Error('codespan rendered live HTML: '+bad.outerHTML);
 const codes=[...app.querySelectorAll('.md code')];
 if(codes.length!==payloads.length) throw Error('code count: '+codes.length);
 for(let i=0;i<payloads.length;i++){ if(codes[i].textContent!==payloads[i]) throw Error('code text mismatch #'+i+': '+JSON.stringify(codes[i].textContent)); }
 if(window.__xss!==undefined) throw Error('payload executed: '+window.__xss);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.stack;document.body.append(p);}
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Codespan escape",
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

const installedRhythm = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installedRhythm.length)(
	"locks the markdown list rhythm and the inline code size",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "md-rhythm-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installedRhythm[0]!.kind, rootDir: join(root, "browser") });
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
import {Markdown} from '/js/markdown.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const B='\\x60';
 const F=B+B+B;
 const md=[
  '开头段落，含 ' + B + '行内代码' + B + ' 混排。',
  '',
  '## 二级标题',
  '',
  '- 顶层项一',
  '- 顶层项二',
  '',
  '1. 松散项一',
  '2. 松散项二：',
  '',
  '   第二段文字，带 ' + B + 'code' + B + '。',
  '',
  '   ' + F + 'ts',
  '   const a = 1;',
  '   ' + F,
  '',
  '   - 嵌套项一',
  '   - 嵌套项二',
  '',
  '3. 松散项三',
  '',
  '#### 四级标题',
  '',
  '> 引用第一段。',
  '>',
  '> - 引用末列表项一',
  '> - 引用末列表项二',
  '',
  '收尾段落。',
 ].join('\\n');
 app.innerHTML='<div class="final"><div id="mdbox"></div></div>';
 render(h(Markdown,{text:md}),document.getElementById('mdbox'));
 await wait(300);
 const cs=el=>getComputedStyle(el);
 const px=v=>parseFloat(v);
 const near=(a,b,tol,label)=>{ if(!(Math.abs(a-b)<=tol)) throw Error(label+': '+a+' vs '+b); };
 // .md li：上下 0.3em
 const tightLi=app.querySelector('.md > ul > li');
 if(!tightLi) throw Error('no top-level li');
 let s=cs(tightLi);
 near(px(s.marginTop),0.3*px(s.fontSize),0.1,'li marginTop');
 near(px(s.marginBottom),0.3*px(s.fontSize),0.1,'li marginBottom');
 // 嵌套 .md li > ul：上下 0.35em（不是 0，也不是顶层的 0.85em）
 const nestedUl=app.querySelector('.md li > ul');
 if(!nestedUl) throw Error('no nested li > ul');
 s=cs(nestedUl);
 const nfs=px(s.fontSize);
 if(px(s.marginTop)<0.01) throw Error('nested ul marginTop is 0');
 if(px(s.marginBottom)<0.01) throw Error('nested ul marginBottom is 0');
 if(Math.abs(px(s.marginBottom)-0.85*nfs)<0.1) throw Error('nested ul marginBottom is still 0.85em');
 near(px(s.marginTop),0.35*nfs,0.1,'nested ul marginTop');
 near(px(s.marginBottom),0.35*nfs,0.1,'nested ul marginBottom');
 // .md li > p：首个 margin-top 为 0 且（首末同体）margin-bottom 为 0；非首非末上下 0.35em
 const liPs=[...app.querySelectorAll('.md li > p')];
 if(liPs.length<3) throw Error('li > p count: '+liPs.length);
 s=cs(liPs[0]);
 near(px(s.marginTop),0,0.01,'first li>p marginTop');
 near(px(s.marginBottom),0,0.01,'only-child-block li>p marginBottom');
 const midP=liPs[2];
 const liP=cs(midP); const pf=px(liP.fontSize);
 near(px(liP.marginTop),0.35*pf,0.1,'mid li>p marginTop');
 near(px(liP.marginBottom),0.35*pf,0.1,'mid li>p marginBottom');
 // .md li .code-block：上下 0.35em
 const liCB=app.querySelector('.md li .code-block');
 if(!liCB) throw Error('no li .code-block');
 s=cs(liCB);
 near(px(s.marginTop),0.35*px(s.fontSize),0.1,'li code-block marginTop');
 near(px(s.marginBottom),0.35*px(s.fontSize),0.1,'li code-block marginBottom');
 // 回归锁：顶层 .md > ul 与 .md > p 下边距仍为 0.85em
 const ulTop=app.querySelector('.md > ul');
 s=cs(ulTop);
 near(px(s.marginBottom),0.85*px(s.fontSize),0.1,'top ul marginBottom');
 const pTop=app.querySelector('.md > p');
 s=cs(pTop);
 near(px(s.marginBottom),0.85*px(s.fontSize),0.1,'top p marginBottom');
 // .md p code：字号 = 0.92 × 正文字号（±0.1px），padding 仍是 0.12em / 0.38em 的比例（与改前同一 em 值）
 const code=app.querySelector('.md p code');
 if(!code) throw Error('no inline code');
 s=cs(code);
 const pfs=px(cs(code.closest('p')).fontSize);
 near(px(s.fontSize),0.92*pfs,0.1,'inline code fontSize');
 near(px(s.paddingTop),0.12*px(s.fontSize),0.1,'inline code paddingTop');
 near(px(s.paddingBottom),0.12*px(s.fontSize),0.1,'inline code paddingBottom');
 near(px(s.paddingLeft),0.38*px(s.fontSize),0.1,'inline code paddingLeft');
 near(px(s.paddingRight),0.38*px(s.fontSize),0.1,'inline code paddingRight');
 // .md blockquote：上下内边距 0.3em，末子块 margin-bottom 为 0
 const bq=app.querySelector('.md blockquote');
 if(!bq) throw Error('no blockquote');
 s=cs(bq);
 const bfs=px(s.fontSize);
 near(px(s.paddingTop),0.3*bfs,0.1,'blockquote paddingTop');
 near(px(s.paddingBottom),0.3*bfs,0.1,'blockquote paddingBottom');
 const bqLast=bq.querySelector(':scope > :last-child');
 near(px(cs(bqLast).marginBottom),0,0.01,'blockquote last-child marginBottom');
 // h2 / h4：上下边距沿用改前实测值（1.3em / 0.5em × 自身字号）
 const h2=app.querySelector('.md h2');
 s=cs(h2); const h2fs=px(s.fontSize);
 near(px(s.marginTop),1.3*h2fs,0.1,'h2 marginTop');
 near(px(s.marginBottom),0.5*h2fs,0.1,'h2 marginBottom');
 const h4=app.querySelector('.md h4');
 s=cs(h4); const h4fs=px(s.fontSize);
 near(px(s.marginTop),1.3*h4fs,0.1,'h4 marginTop');
 near(px(s.marginBottom),0.5*h4fs,0.1,'h4 marginBottom');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {const p=document.createElement('p');p.id='ready';p.textContent=error.stack;document.body.append(p);}
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Markdown rhythm",
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
