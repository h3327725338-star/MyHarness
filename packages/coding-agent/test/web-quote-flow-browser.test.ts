import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The quote flow as a real user does it: pick a passage in the conversation, write what it means, save it (nothing is
 * sent), stack several of them above the input, drop one again, then send. Checked in a real browser because the
 * bubble depends on the page's own selection, painting and keyboard.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"quotes only from the message body, saves a note in place, stacks cards and sends them with the message",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		const base = artifacts ? join(artifacts, "tests") : tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "quote-flow-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const prompts: string[] = [];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("GET", "/api/test/prompts", () => ({ prompts }));
			server.route("POST", "/api/prompt", ({ body }) => {
				prompts.push(String((body as { text?: string }).text ?? ""));
				return { ok: true };
			});
			server.route("POST", "/api/files/upload", () => ({
				name: "note-file.txt",
				path: "C:/session/uploads/note-file.txt",
			}));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("POST", "/api/modes/state", () => ({
				state: { lastSessionFile: null, model: null, drafts: {} },
			}));
			server.route("GET", "/api/modes/state", () => ({
				coding: { lastSessionFile: null, model: null, drafts: {} },
				general: { lastSessionFile: null, model: null, drafts: {} },
			}));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				tools: [],
				skills: [],
				prompts: [],
				extensions: [],
				contextFiles: [],
			}));
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.route("GET", "/api/stats", () => ({}));
			server.mount({ prefix: "/test/", directory: root });

			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {Composer} from '/js/composer.js';
import {FloatingQuoteToolbar} from '/js/quote-toolbar.js';
import {set,state} from '/js/store.js';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const tell=(m)=>document.body.insertAdjacentHTML('beforeend','<p id="ready">'+m+'</p>');
window.addEventListener('error',e=>tell('uncaught: '+(e.message||String(e.error))));
window.addEventListener('unhandledrejection',e=>tell('rejected: '+(e.reason&&e.reason.message||String(e.reason))));
const snap={session:{id:'test',file:'C:/t/test.jsonl',persisted:true,name:null},cwd:'C:/t',flags:{},active:false,
 model:{id:'m',label:'M',input:['text'],contextWindow:8000,maxTokens:1000},thinking:{supported:false},trust:{trusted:true,requiresTrust:false},
 context:{budget:{activeTokens:120,effectiveWindow:8000,percent:2}},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}}};
set({connected:true,everConnected:true,models:[],slots:[],activeSlot:'s1',gitStatus:null,dialogs:[],queue:{steering:[],followUp:[]},runs:{},toolRuns:{},userBash:{},userBashOrder:[],
 surface:{widgets:{},statuses:{}},resources:{commands:[],tools:[],skills:[],prompts:[],extensions:[],contextFiles:[]},modeState:{coding:{drafts:{}},general:{drafts:{}}},
 items:[{kind:'user',id:'u1',ts:1,text:'alpha beta gamma delta epsilon zeta',images:[]},
        {kind:'user',id:'u2',ts:2,text:'one more line about theta and iota',images:[]},
        {kind:'assistant',ts:3,blocks:[{type:'text',text:'the answer speaks about kappa lambda mu'}],stopReason:'stop',final:true}],
 snap:{...snap}});
const app=document.getElementById('app');
app.innerHTML='<div id="th"></div>';
render(h(Transcript,{}),document.getElementById('th'));
render(h(Composer,{}),document.getElementById('ch'));
render(h(FloatingQuoteToolbar,{}),document.getElementById('qh'));
await wait(250);
check(!!document.querySelector('.transcript .user-text'),'the conversation did not render');
check(!!document.querySelector('.transcript .final'),'the Agent answer did not render');

function selectText(container,needle){
 const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const at=node.nodeValue.indexOf(needle);
  if(at>=0){const r=document.createRange();r.setStart(node,at);r.setEnd(node,at+needle.length);
   const s=getSelection();s.removeAllRanges();s.addRange(r);return r;}
 }
 throw Error('text not found: '+needle);
}
const release=()=>document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
async function pick(needle,{host='.transcript',note=null,attach=false}={}){
 selectText(document.querySelector(host),needle);
 await release();await wait(80);
 check(!!document.querySelector('.floating-quote-bar'),'no Quote bubble for a selection in the message body');
 document.querySelector('.floating-quote-btn').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
 await wait(80);
 const card=document.querySelector('.quote-note-card');
 check(!!card,'clicking Quote does not open the in-place annotation box');
 if(note!==null){const area=card.querySelector('.quote-note-input');area.value=note;area.dispatchEvent(new InputEvent('input',{bubbles:true}));}
 if(attach){const dt=new DataTransfer();dt.items.add(new File(['hello world'],'note-file.txt',{type:'text/plain'}));
  const input=card.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
 await wait(60);
 if(attach) check(card.querySelector('.quote-note-file'),'the picked file is not listed in the annotation box');
 return card;
}
async function saveWithEnter(card){
 const area=card.querySelector('.quote-note-input');
 area.focus();
 area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await wait(200);
 check(!document.querySelector('.quote-note-card'),'Enter left the annotation box open');
}
const paintedText=()=>{
 const set=window.CSS && CSS.highlights && CSS.highlights.get('myharness-quote');
 if(set) return [...set].map(r=>r.toString().replace(/\\s+/g,' ').trim()).join('|');
 return [...document.querySelectorAll('.transcript .quote-hl')].map(s=>s.textContent.replace(/\\s+/g,' ').trim()).join('|');
};

try {
// 1) a passage of a user message, with a note: Enter saves it, nothing is sent.
const first=await pick('beta gamma',{note:'note about beta'});
await saveWithEnter(first);
check(document.querySelectorAll('.quote-card').length===1,'the saved quote is not mounted above the input');
check(document.querySelector('.quote-card-note').textContent.includes('note about beta'),'the card does not show the note');
check(paintedText().includes('beta gamma'),'the quoted passage is not painted in the body');
check(state.items.length===3,'saving a quote sent a message');
const draft=document.querySelector('.composer-input');
check(!draft.textContent.trim(),'saving a quote put text in the main input');

// 2) the Agent's own answer can be quoted too, and a file picked with it joins the attachments.
const second=await pick('kappa lambda',{note:'about the answer',attach:true});
await wait(300);
await saveWithEnter(second);
check(document.querySelectorAll('.quote-card').length===2,'a second quote did not stack beside the first: '+document.querySelectorAll('.quote-card').length+' cards ['+[...document.querySelectorAll('.quote-card')].map(c=>c.textContent).join(' | ')+']');
check(!!document.querySelector('.composer .file-attachment'),'the file picked with the quote was not attached');
check(paintedText().includes('kappa lambda'),'the second quote is not painted in the body');

// 3) dropping one card takes its body highlight away and keeps the other.
const dropped=paintedText();
document.querySelectorAll('.quote-card .quote-card-x')[0].click();
await wait(140);
check(document.querySelectorAll('.quote-card').length===1,'the card did not delete on its own');
check(!paintedText().includes('beta gamma'),'the removed quote is still painted in the body');
check(paintedText().includes('kappa lambda'),'deleting one quote removed the highlight of another');
check(dropped.includes('beta gamma'),'the first quote was never painted at all');

// 4) quotes alone can be sent, and the body keeps the block quote plus the note.
const send=document.querySelector('.send');
check(!send.disabled && send.classList.contains('ready'),'an empty input with a mounted quote cannot be sent');
send.click();
await wait(300);
const sent=await (await fetch('/api/test/prompts')).json();
check(sent.prompts.length===1,'sending a quote without typing text did not reach the server');
check(sent.prompts[0].includes('> ') && sent.prompts[0].includes('kappa lambda'),'the sent message lost the quoted passage');
check(sent.prompts[0].includes('about the answer'),'the sent message lost the note');
check(!document.querySelector('.quote-shelf'),'the quote cards survived the send');
check(paintedText()==='','the body highlight survived the send');

// 5) a passage plus typed text: the note of the box never sends the conversation itself.
const third=await pick('theta',{note:'why theta matters'});
third.querySelector('.quote-note-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));
await wait(40);
check(!!document.querySelector('.quote-note-card'),'Shift+Enter closed the annotation box instead of breaking a line');
const area=document.querySelector('.quote-note-input');
area.value='why theta matters\\nmakes it configurable';
area.dispatchEvent(new InputEvent('input',{bubbles:true}));
await wait(30);
area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
await wait(140);
check(document.querySelectorAll('.quote-card').length===1,'a multi-line note was not saved');
check(document.querySelector('.quote-card').textContent.includes('why theta matters'),'the multi-line note is not on the card');
draft.focus();
draft.textContent='what I actually ask';
draft.dispatchEvent(new InputEvent('input',{bubbles:true}));
await wait(60);
draft.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
await wait(300);
const sent2=await (await fetch('/api/test/prompts')).json();
check(sent2.prompts.length===2,'the message with a quote and text was not sent');
const last=sent2.prompts[1];
check(last.includes('> ') && last.includes('theta'),'the quoted passage is missing from the sent message');
check(last.includes('why theta matters'),'the note is missing from the sent message');
check(last.includes('makes it configurable'),'the second line of the note is missing from the sent message');
check(last.includes('what I actually ask'),'the typed text is missing from the sent message');
check(last.indexOf('what I actually ask')>last.indexOf('> '),'the quoted passage must come before the question');
check(!document.querySelector('.quote-shelf') && paintedText()==='','quotes were not cleared after sending');

// 6) nowhere else on the page offers a quote.
draft.focus();draft.textContent='typing inside the input';draft.dispatchEvent(new InputEvent('input',{bubbles:true}));
await wait(60);
for (const [host,needle] of [['.sidebar','sidebar passage'],['.panel','panel passage'],['.modal','modal passage'],['.composer-input','typing inside']]) {
 const el=document.querySelector(host);
 check(el,host+' is missing from the page');
 selectText(el,needle);
 await release();
 await wait(80);
 check(!document.querySelector('.floating-quote-bar'),'the Quote bubble appears in '+host);
 getSelection().removeAllRanges();
}

tell('passed');
} catch(e) { tell('failed: '+((e&&e.message)||String(e))); }
`,
			);
			writeFileSync(
				join(root, "index.html"),
				`<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div class="app"><aside class="sidebar"><p>sidebar passage that must not be quotable</p></aside><main class="main"><div id="app"></div><div id="ch"></div><div id="qh"></div></main><aside class="panel"><div class="panel-body"><p>panel passage that must not be quotable</p></div></aside></div><div class="scrim"><div class="modal"><p>modal passage that must not be quotable</p></div></div><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Quote flow test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	180000,
);

/**
 * The same in-body feedback on a browser without the Custom Highlight API: the passages are then marked with spans,
 * which must not change the visible text, and taken away again without leaving the text in pieces.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"marks and unmarks quoted passages with spans when the browser cannot paint a text range",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		const base = artifacts ? join(artifacts, "tests") : tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "quote-paint-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			writeFileSync(
				join(root, "paint.js"),
				`
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const tell=(m)=>document.body.insertAdjacentHTML('beforeend','<p id="ready">'+m+'</p>');
try {
 // The modern painter is off, exactly as on an older browser.
 window.Highlight=undefined;
 const painter=await import('/js/quote-highlight.js');
 check(painter.nativeHighlights()===false,'the browser still reports Highlight support');
 const host=document.querySelector('.user-text');
 const before=host.textContent;
 painter.paintQuotes([{id:'q1',text:'beta gamma'},{id:'q2',text:'delta epsilon'},{id:'q3',text:'zeta eta'}]);
 await wait(150);
 const marked=[...document.querySelectorAll('.transcript .quote-hl')];
 check(marked.length===3,'every mounted quote should be marked once, got '+marked.length+' ['+marked.map(m=>m.textContent).join(' | ')+']');
 check(marked.map(m=>m.textContent).join('/')==='beta gamma/delta epsilon/zeta eta','wrong passages marked: '+marked.map(m=>m.textContent).join('/'));
 check(host.textContent===before,'marking changed the visible text');
 check(marked.every(m=>m.dataset.quoteId),'a mark does not know which quote it belongs to');
 // Dropping one card must take exactly its own mark away and leave the sentence whole.
 painter.paintQuotes([{id:'q1',text:'beta gamma'},{id:'q3',text:'zeta eta'}]);
 await wait(150);
 const left=[...document.querySelectorAll('.transcript .quote-hl')];
 check(left.length===2,'deleting one quote changed the marks of others: '+left.map(m=>m.textContent).join('/'));
 check(left.map(m=>m.textContent).join('/')==='beta gamma/zeta eta','the wrong passage survived: '+left.map(m=>m.textContent).join('/'));
 check(host.textContent===before,'unwrapping a mark lost or duplicated text');
 // A passage that is not on the page yet is simply not painted, and still is once it appears.
 painter.paintQuotes([{id:'q4',text:'not on the page'}]);
 await wait(60);
 check(document.querySelectorAll('.transcript .quote-hl').length===0,'a missing passage was painted anyway');
 host.insertAdjacentHTML('beforeend',' <em>now it is here: not on the page</em>');
 await wait(1200);
 check(document.querySelectorAll('.transcript .quote-hl').length===1,'a passage that arrived later was never looked for again');
 check(document.querySelector('.transcript .quote-hl').textContent==='not on the page','the late passage was marked in the wrong place');
 painter.clearQuoteHighlights();
 await wait(60);
 check(document.querySelectorAll('.quote-hl').length===0,'clearing left marks behind');
 tell('passed');
} catch(e) { tell('failed: '+((e&&e.message)||String(e))); }
`,
			);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><div class="transcript"><div class="md user-text"><p>alpha <strong>beta gamma</strong> delta epsilon zeta eta</p></div></div><script type="module" src="/test/paint.js"></script>',
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Quote paint test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	180000,
);

/**
 * The same words twice (a table that says "同上" in two cells, laid out with newlines and indents between the cells):
 * the passage painted must be the copy that was selected, not the first copy on the page.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"paints the selected copy of a repeated passage, not an earlier one",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		const base = artifacts ? join(artifacts, "tests") : tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "quote-repeat-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			writeFileSync(
				join(root, "repeat.js"),
				`
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const tell=(m)=>document.body.insertAdjacentHTML('beforeend','<p id="ready">'+m+'</p>');
try {
 window.Highlight=undefined;
 const painter=await import('/js/quote-highlight.js');
 const target=document.querySelector('#second').firstChild;
 const range=document.createRange();
 range.setStart(target,0);range.setEnd(target,2);
 const hint=painter.selectionHint(range);
 painter.paintQuotes([{id:'q1',text:'同上',hint}]);
 await wait(150);
 const marked=[...document.querySelectorAll('.transcript .quote-hl')];
 check(marked.length===1,'expected one mark, got '+marked.length);
 check(marked[0].closest('td')?.id==='second','painted the wrong copy: '+(marked[0].closest('td')?.id||'none'));
 tell('passed');
} catch(e) { tell('failed: '+((e&&e.message)||String(e))); }
`,
			);
			const pad = "\n            ";
			const filler = Array.from(
				{ length: 40 },
				(_, i) => `<tr>${pad}<td>row ${i}</td>${pad}<td>text ${i}</td>${pad}</tr>`,
			).join(pad);
			writeFileSync(
				join(root, "index.html"),
				`<!doctype html><meta charset="utf-8"><div class="transcript"><div class="final"><table>${pad}<tr>${pad}<td>新闻（同上，同一篇里的另一个家庭）</td>${pad}<td id="first">同上</td>${pad}</tr>${pad}${filler}${pad}<tr>${pad}<td>新闻</td>${pad}<td id="second">同上</td>${pad}</tr>${pad}</table></div></div><script type="module" src="/test/repeat.js"></script>`,
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Quote repeat test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	180000,
);

/**
 * The same quote UI under every colour theme the product has (classic / forest / amber in dark, plus the light display):
 * the bubble and the annotation box must sit on the theme's own surface, stay inside the window, keep the quoted passage
 * readable, and the highlight must really follow the palette instead of one hard-coded colour. The span painter is forced
 * on so the painted background is a measurable element; marking text with spans does not change what is shown.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"themes the quote bubble, the annotation box and the body highlight for every colour theme",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		const base = artifacts ? join(artifacts, "tests") : tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "quote-theme-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("POST", "/api/prompt", () => ({ ok: true }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("POST", "/api/modes/state", () => ({
				state: { lastSessionFile: null, model: null, drafts: {} },
			}));
			server.route("GET", "/api/modes/state", () => ({
				coding: { lastSessionFile: null, model: null, drafts: {} },
				general: { lastSessionFile: null, model: null, drafts: {} },
			}));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				tools: [],
				skills: [],
				prompts: [],
				extensions: [],
				contextFiles: [],
			}));
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.route("GET", "/api/stats", () => ({}));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {Composer} from '/js/composer.js';
import {FloatingQuoteToolbar} from '/js/quote-toolbar.js';
import {set} from '/js/store.js';
window.Highlight=undefined;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const tell=(m)=>document.body.insertAdjacentHTML('beforeend','<p id="ready">'+m+'</p>');
const token=(name)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const rgba=(s)=>{const v=(s||'').trim();const m=/^rgba?[(]([^)]+)[)]$/.exec(v);if(!m) return null;const p=m[1].split(/[^0-9.-]+/).filter((x)=>x.length).map(Number);if(p.length<3||p.slice(0,3).some((n)=>!isFinite(n))) return null;return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};};
const surface=(name)=>{const d=document.createElement('div');d.style.backgroundColor='var('+name+')';document.body.appendChild(d);const v=getComputedStyle(d).backgroundColor;d.remove();return v;};
const bgOf=(el)=>{for(let n=el;n;n=n.parentElement){const raw=getComputedStyle(n).backgroundColor;const c=rgba(raw);if(c&&c.a===1) return {c:c,from:n.className+' | '+raw};} return {c:{r:255,g:255,b:255,a:1},from:'no opaque background found'};};
const mix=(fg,bg)=>({r:fg.r*fg.a+bg.r*(1-fg.a),g:fg.g*fg.a+bg.g*(1-fg.a),b:fg.b*fg.a+bg.b*(1-fg.a),a:1});
const lum=(c)=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};
const contrast=(a,b)=>{const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);};
const onScreen=(el,what)=>{const r=el.getBoundingClientRect();check(r.left>=-0.5&&r.right<=window.innerWidth+0.5&&r.top>=-0.5&&r.bottom<=window.innerHeight+0.5,what+' is off the screen: '+r.left+','+r.top+','+r.right+','+r.bottom+' in '+window.innerWidth+'x'+window.innerHeight);};
function selectText(container,needle){
 const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const at=node.nodeValue.indexOf(needle);
  if(at>=0){const r=document.createRange();r.setStart(node,at);r.setEnd(node,at+needle.length);
   const s=getSelection();s.removeAllRanges();s.addRange(r);return r;}
 }
 throw Error('text not found: '+needle);
}
const snap={session:{id:'test',file:'C:/t/test.jsonl',persisted:true,name:null},cwd:'C:/t',flags:{},active:false,
 model:{id:'m',label:'M',input:['text'],contextWindow:8000,maxTokens:1000},thinking:{supported:false},trust:{trusted:true,requiresTrust:false},
 context:{budget:{activeTokens:120,effectiveWindow:8000,percent:2}},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}}};
set({connected:true,everConnected:true,models:[],slots:[],activeSlot:'s1',gitStatus:null,dialogs:[],queue:{steering:[],followUp:[]},runs:{},toolRuns:{},userBash:{},userBashOrder:[],
 surface:{widgets:{},statuses:{}},resources:{commands:[],tools:[],skills:[],prompts:[],extensions:[],contextFiles:[]},modeState:{coding:{drafts:{}},general:{drafts:{}}},
 items:[{kind:'user',id:'u1',ts:1,text:'alpha beta gamma delta epsilon zeta',images:[]}],snap:{...snap}});
const app=document.getElementById('app');
app.innerHTML='<div id="th"></div>';
render(h(Transcript,{}),document.getElementById('th'));
render(h(Composer,{}),document.getElementById('ch'));
render(h(FloatingQuoteToolbar,{}),document.getElementById('qh'));
await wait(300);
check(!document.querySelector('.transcript .quote-hl'),'a quote is painted before anything was picked');
const themes=[['dark','classic'],['dark','forest'],['dark','amber'],['light','classic']];
const seen={};
try {
for (const theme of themes) {
 const name=theme[0]+'/'+theme[1];
 document.documentElement.dataset.theme=theme[0];
 if(theme[1]==='classic') delete document.documentElement.dataset.colorTheme; else document.documentElement.dataset.colorTheme=theme[1];
 await wait(40);
 const paint=token('--quote-hl-bg');
 check(paint,'--quote-hl-bg is not defined in '+name);
 check(!seen[paint],'the quote highlight is the same colour in '+seen[paint]+' and '+name);
 seen[paint]=name;
 check(token('--quote-hl-edge'),'--quote-hl-edge is not defined in '+name);

 selectText(document.querySelector('.transcript .user-text'),'beta gamma');
 document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
 await wait(90);
 const bar=document.querySelector('.floating-quote-bar');
 check(bar,'no Quote bubble in '+name);
 const bubble=getComputedStyle(bar);
 check(bubble.backgroundColor===surface('--bg-raised'),'the Quote bubble does not use the theme surface in '+name+': '+bubble.backgroundColor);
 check(bubble.boxShadow!=='none','the Quote bubble lost its shadow in '+name);
 onScreen(bar,'the Quote bubble in '+name);

 bar.querySelector('.floating-quote-btn').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
 await wait(90);
 const card=document.querySelector('.quote-note-card');
 check(card,'no annotation box in '+name);
 const box=getComputedStyle(card);
 check(box.backgroundColor===bubble.backgroundColor,'the bubble and the annotation box use different surfaces in '+name);
 onScreen(card,'the annotation box in '+name);
 const area=card.querySelector('.quote-note-input');
 const field=area.getBoundingClientRect(), head=card.getBoundingClientRect();
 check(field.width>0&&field.height>=40&&field.left>=head.left-0.5&&field.right<=head.right+0.5,'the annotation field does not fit its box in '+name);
 const areaColor = rgba(getComputedStyle(area).color);
 const areaBg = bgOf(area);
 check(
  areaColor && contrast(areaColor, areaBg.c) >= 4.5,
  'the annotation text is hard to read in ' + name + ': ' + getComputedStyle(area).color + ' on ' + areaBg.from + ' = ' + (areaColor ? contrast(areaColor, areaBg.c).toFixed(2) : 'unparsed'),
 );
 check(!!card.querySelector('.quote-note-keys'),'the box does not explain its keys in '+name);

 area.value='readable here';
 area.dispatchEvent(new InputEvent('input',{bubbles:true}));
 await wait(30);
 area.focus();
 area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await wait(240);
 check(!document.querySelector('.quote-note-card'),'the annotation box stayed open in '+name);
 const marked=document.querySelector('.transcript .quote-hl');
 check(marked,'the quoted passage is not painted in '+name);
 const ink = rgba(getComputedStyle(marked).color);
 const tint = rgba(getComputedStyle(marked).backgroundColor);
 const behindPassage = bgOf(marked.parentElement).c;
 check(tint, 'the painted passage has no readable background colour: ' + getComputedStyle(marked).backgroundColor);
 const on = mix(tint, behindPassage);
 const ratio = contrast(ink, on);
 check(ratio >= 4.5, 'the quoted passage is hard to read in ' + name + ': ' + getComputedStyle(marked).color + ' on ' + getComputedStyle(marked).backgroundColor + ' = ' + ratio.toFixed(2));
 const mounted=document.querySelector('.quote-card');
 check(mounted,'the saved quote is not mounted above the input in '+name);
 const cross=mounted.querySelector('.quote-card-x').getBoundingClientRect(), body=mounted.getBoundingClientRect();
 check(cross.right<=body.right+0.5&&cross.top>=body.top-0.5&&cross.bottom<=body.bottom+0.5,'the delete button sits outside the card in '+name);
 onScreen(mounted,'the quote card in '+name);

 mounted.querySelector('.quote-card-x').click();
 await wait(160);
 check(!document.querySelector('.quote-card'),'the card stayed in '+name);
 check(!document.querySelector('.transcript .quote-hl'),'removing the card left its highlight behind in '+name);
 getSelection().removeAllRanges();
 await wait(40);
}
check(Object.keys(seen).length===themes.length,'the quote highlight does not follow the palette: '+JSON.stringify(seen));
tell('passed');
} catch(e) { tell('failed: '+((e&&e.message)||String(e))); }
`,
			);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div class="app"><main class="main"><div id="app"></div><div id="ch"></div><div id="qh"></div></main></div><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Quote theme test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	180000,
);

/**
 * W152: pasting (Ctrl+V) inside the annotation box joins the box's own file list exactly like the paperclip does,
 * a plain-text paste stays untouched for the browser, and the compact box holds its numbers in both locales.
 * Checked in a real browser: the clipboard event, the measured layout and the two languages only exist where Chrome
 * runs the CSS.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"pasting files in the quote box feeds its own attachment chips, plain text stays pasted, the compact box fits its numbers",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		const base = artifacts ? join(artifacts, "tests") : tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "quote-paste-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			server.route("POST", "/api/prompt", () => ({ ok: true }));
			server.route("POST", "/api/files/upload", () => ({
				name: "note-file.txt",
				path: "C:/session/uploads/note-file.txt",
			}));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("POST", "/api/modes/state", () => ({
				state: { lastSessionFile: null, model: null, drafts: {} },
			}));
			server.route("GET", "/api/modes/state", () => ({
				coding: { lastSessionFile: null, model: null, drafts: {} },
				general: { lastSessionFile: null, model: null, drafts: {} },
			}));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				tools: [],
				skills: [],
				prompts: [],
				extensions: [],
				contextFiles: [],
			}));
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.route("GET", "/api/stats", () => ({}));
			server.mount({ prefix: "/test/", directory: root });

			writeFileSync(
				join(root, "paste.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {Composer} from '/js/composer.js';
import {FloatingQuoteToolbar} from '/js/quote-toolbar.js';
import {set} from '/js/store.js';
import {setLang} from '/js/lang.js';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const tell=(m)=>document.body.insertAdjacentHTML('beforeend','<p id="ready">'+m+'</p>');
window.addEventListener('error',e=>tell('uncaught: '+(e.message||String(e.error))));
window.addEventListener('unhandledrejection',e=>tell('rejected: '+(e.reason&&e.reason.message||String(e.reason))));
const snap={session:{id:'test',file:'C:/t/test.jsonl',persisted:true,name:null},cwd:'C:/t',flags:{},active:false,
 model:{id:'m',label:'M',input:['text'],contextWindow:8000,maxTokens:1000},thinking:{supported:false},trust:{trusted:true,requiresTrust:false},
 context:{budget:{activeTokens:120,effectiveWindow:8000,percent:2}},queue:{steering:[],followUp:[]},dialogs:[],surface:{widgets:{},statuses:{}}};
set({connected:true,everConnected:true,models:[],slots:[],activeSlot:'s1',gitStatus:null,dialogs:[],queue:{steering:[],followUp:[]},runs:{},toolRuns:{},userBash:{},userBashOrder:[],
 surface:{widgets:{},statuses:{}},resources:{commands:[],tools:[],skills:[],prompts:[],extensions:[],contextFiles:[]},modeState:{coding:{drafts:{}},general:{drafts:{}}},
 items:[{kind:'user',id:'u1',ts:1,text:'alpha beta gamma delta epsilon zeta',images:[]},
        {kind:'user',id:'u2',ts:2,text:'one more line about theta and iota',images:[]},
        {kind:'assistant',ts:3,blocks:[{type:'text',text:'the answer speaks about kappa lambda mu'}],stopReason:'stop',final:true}],snap:{...snap}});
const app=document.getElementById('app');
app.innerHTML='<div id="th"></div>';
render(h(Transcript,{}),document.getElementById('th'));
render(h(Composer,{}),document.getElementById('ch'));
render(h(FloatingQuoteToolbar,{}),document.getElementById('qh'));
await wait(250);
check(!!document.querySelector('.transcript .user-text'),'the conversation did not render');
check(!!document.querySelector('.transcript .final'),'the Agent answer did not render');

function selectText(container,needle){
 const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const at=node.nodeValue.indexOf(needle);
  if(at>=0){const r=document.createRange();r.setStart(node,at);r.setEnd(node,at+needle.length);
   const s=getSelection();s.removeAllRanges();s.addRange(r);return r;}
 }
 throw Error('text not found: '+needle);
}
const release=()=>document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
async function pick(needle){
 selectText(document.querySelector('.transcript'),needle);
 await release();await wait(90);
 const bar=document.querySelector('.floating-quote-bar');
 check(bar,'no Quote bubble for a selection in the message body: '+needle);
 bar.querySelector('.floating-quote-btn').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
 await wait(90);
 const card=document.querySelector('.quote-note-card');
 check(card,'clicking Quote does not open the in-place annotation box for: '+needle);
 return card;
}
const PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBytes=()=>Uint8Array.from(atob(PNG_B64),function(c){return c.charCodeAt(0);});
async function pasteInto(el,file){
 const dt=new DataTransfer();
 dt.items.add(file);
 const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});
 if(!ev.clipboardData) Object.defineProperty(ev,'clipboardData',{value:dt,configurable:true});
 return el.dispatchEvent(ev);
}
const saveQuote=(card)=>card.querySelector('.quote-note-foot .btn.primary');
const thumbs=()=>document.querySelectorAll('.composer .attachments .thumb').length;
const boxFiles=(card)=>card.querySelectorAll('.quote-note-file').length;

try {
// 1) a pasted image is taken over: one chip here, the note text and the box untouched; saving mounts it into the
//    main input's attachment list together with the quote card.
const card1=await pick('beta gamma');
const area1=card1.querySelector('.quote-note-input');
area1.focus();
const returned1=await pasteInto(area1,new File([pngBytes()],'pasted-shot.png',{type:'image/png'}));
check(returned1===false,'a pasted image was not taken over by the annotation box');
await wait(80);
check(boxFiles(card1)===1,'the pasted image did not turn into a chip: '+boxFiles(card1)+' chips');
check(card1.querySelector('.quote-note-input').value==='','pasting an image polluted the note text');
check(!!document.querySelector('.quote-note-card'),'pasting an image closed the box');
check(card1.contains(document.activeElement),'pasting an image moved the caret out of the box');
check(thumbs()===0,'the pasted image reached the input attachments before saving');
saveQuote(card1).click();
await wait(350);
check(!document.querySelector('.quote-note-card'),'Save quote did not close the box');
check(thumbs()===1,'the pasted image never joined the main input attachment list: '+thumbs()+' thumbs');
check(document.querySelectorAll('.quote-card').length===1,'the saved quote card is missing');

// 2) a plain-text paste is not taken over: the event is not prevented and no chip appears.
const card2=await pick('delta epsilon');
const dt2=new DataTransfer();
try{dt2.setData('text/plain','clipboard words');}catch(e){}
const ev2=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt2});
if(!ev2.clipboardData) Object.defineProperty(ev2,'clipboardData',{value:dt2,configurable:true});
const returned2=card2.querySelector('.quote-note-input').dispatchEvent(ev2);
check(returned2===true,'a plain-text paste was swallowed by the annotation box');
check(boxFiles(card2)===0,'a plain-text paste created an attachment chip');
card2.querySelector('.quote-note-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
await wait(120);
check(!document.querySelector('.quote-note-card'),'Escape did not close the box after the text paste');

// 3) a pasted non-image file: chip here, and on save the composer's upload pipeline takes it (as the paperclip does).
const card3=await pick('epsilon zeta');
const area3=card3.querySelector('.quote-note-input');
area3.focus();
const returned3=await pasteInto(area3,new File(['hello world'],'a.txt',{type:'text/plain'}));
check(returned3===false,'a pasted file was not taken over by the annotation box');
await wait(60);
check(boxFiles(card3)===1,'the pasted file did not turn into a chip: '+boxFiles(card3)+' chips');
saveQuote(card3).click();
await wait(400);
check(!!document.querySelector('.composer .file-attachment'),'the pasted file did not go through the upload pipeline');
check(thumbs()===2,'the pasted file was not mounted beside the pasted image: '+thumbs()+' thumbs');

// 4) Escape drops the pasted file exactly like a paperclip pick: the box closes and the attachments stay untouched.
const card4=await pick('theta');
const area4=card4.querySelector('.quote-note-input');
area4.focus();
await pasteInto(area4,new File([pngBytes()],'later.png',{type:'image/png'}));
await wait(60);
check(boxFiles(card4)===1,'a second paste produced no chip: '+boxFiles(card4));
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
await wait(150);
check(!document.querySelector('.quote-note-card'),'Escape left the box open');
check(!document.querySelector('.quote-note-file'),'an attachment chip survived the closed box');
check(thumbs()===2,'a cancelled paste still reached the input attachments: '+thumbs()+' thumbs');

// 5) the compact numbers hold in both languages: narrow box, one-line hint, roomy enough note field, no overflow.
for (const lang of ['en','zh-CN']) {
 setLang(lang);
 const card=await pick('alpha beta');
 const box=card.getBoundingClientRect();
 check(box.width>0&&box.width<=320,'the box is wider than 320px in '+lang+': '+box.width);
 check(box.height>0&&box.height<=190,'the box is taller than 190px in '+lang+': '+box.height);
 const keys=card.querySelector('.quote-note-keys');
 check(keys.scrollWidth<=keys.clientWidth,'the key hint overflows its line in '+lang+': '+keys.scrollWidth+' > '+keys.clientWidth);
 const keysH=keys.getBoundingClientRect().height;
 check(keysH>0&&keysH<=20,'the key hint is not a single line in '+lang+': '+keysH+'px');
 const area=card.querySelector('.quote-note-input');
 check(area.getBoundingClientRect().height>=40,'the note field is shorter than 40px in '+lang+': '+area.getBoundingClientRect().height);
 check(card.scrollWidth<=card.clientWidth,'the box overflows horizontally in '+lang);
 area.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await wait(150);
 setLang('en');
 check(!document.querySelector('.quote-note-card'),'the geometry box stayed open in '+lang);
}
tell('passed');
} catch(e) { tell('failed: '+((e&&e.message)||String(e))); }
`,
			);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div class="app"><main class="main"><div id="app"></div><div id="ch"></div><div id="qh"></div></main></div><script src="/markdown/marked.min.js"></script><script type="module" src="/test/paste.js"></script>',
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Quote paste test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	180000,
);
