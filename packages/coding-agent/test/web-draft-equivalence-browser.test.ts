import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// Filled in from the pre-change run after eyeballing every step; the post-change run must match byte for byte.
const EXPECTED_SNAPS: string[] = [
	'type-hello|text="hello"|focus=5|anchor=5|lines=dline active|htmlLen=37|htmlHash=aefbcee1|ae=true|selCb=[5,5]',
	'newline|text="hello"|focus=6|anchor=6|lines=dline;dline active|htmlLen=66|htmlHash=66f49b1b|ae=true|selCb=[6,6]',
	'type-head|text="hello# head"|focus=12|anchor=12|lines=dline;dline dline-h dline-h1 active|htmlLen=112|htmlHash=3def2249|ae=true|selCb=[12,12]',
	'newline2|text="hello# head"|focus=13|anchor=13|lines=dline;dline dline-h dline-h1;dline active|htmlLen=141|htmlHash=f3bb3fe3|ae=true|selCb=[13,13]',
	'type-bold|text="hello# head**bold** done"|focus=26|anchor=26|lines=dline;dline dline-h dline-h1;dline active|htmlLen=221|htmlHash=13393529|ae=true|selCb=[26,26]',
	'caret-2|text="hello# head**bold** done"|focus=2|anchor=2|lines=dline active;dline dline-h dline-h1;dline|htmlLen=221|htmlHash=43473da9|ae=true|selCb=[26,2]',
	'sel-replace|text="HELLO# head**bold** done"|focus=5|anchor=5|lines=dline active;dline dline-h dline-h1;dline|htmlLen=221|htmlHash=9475bd09|ae=true|selCb=[5,5]',
	'backspace-join|text="HELLO# head**bold** done"|focus=5|anchor=5|lines=dline active;dline|htmlLen=152|htmlHash=89769a76|ae=true|selCb=[5,5]',
	'paste-multi|text="HELLOpastedsecond **line**third# head**bold** done"|focus=33|anchor=33|lines=dline;dline;dline active;dline|htmlLen=299|htmlHash=1789353b|ae=true|selCb=[33,33]',
	'undo1|text="HELLO# head**bold** done"|focus=5|anchor=5|lines=dline active;dline|htmlLen=152|htmlHash=89769a76|ae=true|selCb=[5,5]',
	'undo2|text="HELLO# head**bold** done"|focus=6|anchor=6|lines=dline;dline dline-h dline-h1 active;dline|htmlLen=221|htmlHash=8c82a129|ae=true|selCb=[6,6]',
	'redo1|text="HELLO# head**bold** done"|focus=5|anchor=5|lines=dline active;dline|htmlLen=152|htmlHash=89769a76|ae=true|selCb=[5,5]',
	'ime-commit|text="HELLO# head中文**bold** done"|focus=7|anchor=7|lines=dline active;dline|htmlLen=154|htmlHash=17c56dca|ae=true|selCb=[7,7]',
	'select-all|text="HELLO# head中文**bold** done"|focus=27|anchor=0|lines=dline active;dline active|htmlLen=161|htmlHash=c407a5c6|ae=true|selCb=[7,27]',
	'replace-all|text="fresh"|focus=5|anchor=5|lines=dline active|htmlLen=37|htmlHash=459d4e5|ae=true|selCb=[5,5]',
];

/**
 * W206: the DraftEditor behaviour contract. One fixed input script (typing, newlines, Markdown,
 * arrow keys, selection replace, backspace across a line break, multi-line paste, undo/redo,
 * IME composition, select-all replace) records the DOM text, caret offset, selection, line
 * classes and innerHTML after every step and compares them against the snapshot taken on the
 * pre-change code. The draw() rewrite must keep every step byte-identical.
 */
const editorJs = `
import {h,render} from '/vendor/preact.js';
import {DraftEditor} from '/js/draft-editor.js';
import {useState} from '/vendor/preact-hooks.js';
const changes=[];
let api=null;
const selects=[];
function App() {
 const [value,setValue]=useState('');
 return h(DraftEditor,{value,class:'composer-input',placeholder:'Ask',apiRef:{get current(){return api;},set current(v){api=v;}},onChange:(text)=>{changes.push(text);setValue(text);},onSelect:(at)=>{selects.push(at);}});
}
render(h(App),document.getElementById('app'));
const tick=async(ms)=>{
 await new Promise(resolve=>setTimeout(resolve,ms||60));
 // Other workers drive browsers on the same machine; retake the foreground if it was stolen mid-step.
 for(let i=0;i<10&&document.activeElement!==el();i++){el().focus();await new Promise(r=>setTimeout(r,30));}
 if(document.activeElement!==el()) throw Error('could not keep focus in the editor');
};
const el=()=>document.querySelector('.draft');
const caretOf=()=>{
 const root=el();const sel=getSelection();
 if(!sel.rangeCount||!root.contains(sel.anchorNode)) return {caret:-1,anchor:-1,focus:-1};
 const off=(node,at)=>{
  const r=document.createRange();r.setStart(root,0);r.setEnd(node,at);
  let breaks=0;for(const line of root.children){if(r.intersectsNode(line)) breaks++;}
  return r.toString().length+(breaks>0?breaks-1:0);
 };
 const anchor=off(sel.anchorNode,sel.anchorOffset),focus=off(sel.focusNode,sel.focusOffset);
 return {caret:focus,anchor:focus,focus:focus,anchorOff:anchor};
};
const snap=(step)=>{
 const root=el();const c=caretOf();
 let h=5381;const s=root.innerHTML;for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;
 return step+'|text='+JSON.stringify(root.textContent)
  +'|focus='+c.focus+'|anchor='+c.anchorOff
  +'|lines='+[...root.children].map(n=>n.className).join(';')
  +'|htmlLen='+s.length+'|htmlHash='+(h>>>0).toString(16)
  +'|ae='+(document.activeElement===root)+'|selCb='+JSON.stringify(selects.slice(-2));
};
const out=[];
const sel=(a,b)=>{
 const root=el();
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 const texts=[];for(let t=walker.nextNode();t;t=walker.nextNode()) texts.push(t);
 const total=texts.reduce((n,t)=>n+t.data.length,0)+root.children.length-1;
 a=Math.max(0,Math.min(a,total));b=Math.max(0,Math.min(b,total));
 const point=(off)=>{
  let left=off;
  for(let i=0;i<root.children.length;i++){
   const line=root.children[i];const len=line.textContent.length;
   if(left<=len||i===root.children.length-1){
    const w=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
    for(let t=w.nextNode();t;t=w.nextNode()){if(left<=t.data.length) return [t,left];left-=t.data.length;}
    return [line,0];
   }
   left-=len+1;
  }
  return [root,0];
 };
 const [na,oa]=point(a),[nb,ob]=point(b);
 const r=document.createRange();r.setStart(na,oa);r.setEnd(nb,ob);
 getSelection().removeAllRanges();getSelection().addRange(r);
};
const type=(data,inputType)=>{
 el().focus();
 el().dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:inputType||'insertText',data:data}));
};
const key=(k,ctrl)=>{
 el().focus();
 el().dispatchEvent(new KeyboardEvent('keydown',{key:k,ctrlKey:!!ctrl,bubbles:true,cancelable:true}));
};
try {
 await tick(150);
 el().focus();await tick();
 type('hello');await tick();out.push(snap('type-hello'));
 if(el().textContent!=='hello') throw Error('page came up in a bad state (text='+JSON.stringify(el().textContent)+'), retry the run');
 type(null,'insertParagraph');await tick();out.push(snap('newline'));
 type('# head');await tick();out.push(snap('type-head'));
 type(null,'insertParagraph');await tick();out.push(snap('newline2'));
 type('**bold** done');await tick();out.push(snap('type-bold'));
 el().focus();sel(2,2);await tick();out.push(snap('caret-2'));
 el().focus();sel(0,5);type('HELLO');await tick();out.push(snap('sel-replace'));
 el().focus();sel(6,6);await tick();
 type(null,'deleteContentBackward');await tick();out.push(snap('backspace-join'));
 const dt=new DataTransfer();dt.setData('text/plain','pasted\\nsecond **line**\\nthird');
 el().focus();
 el().dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
 await tick();out.push(snap('paste-multi'));
 key('z',true);
 await tick();out.push(snap('undo1'));
 key('z',true);
 await tick();out.push(snap('undo2'));
 key('y',true);
 await tick();out.push(snap('redo1'));
 el().focus();
 el().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 el().firstElementChild.textContent+='zhong';
 el().dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'zhong',isComposing:true}));
 el().firstElementChild.textContent=el().firstElementChild.textContent.replace(/zhong$/,'\\u4e2d\\u6587');
 // The browser keeps the selection at the end of the committed text; setting textContent above dropped it, so put it back.
 el().focus();sel(7,7);
 el().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'\\u4e2d\\u6587'}));
 await tick(150);out.push(snap('ime-commit'));
 key('a',true);
 await tick();out.push(snap('select-all'));
 type('fresh');await tick();out.push(snap('replace-all'));
 const final=el().textContent==='fresh'&&changes[changes.length-1]==='fresh'&&selects[selects.length-1]===5;
 const done=document.createElement('p');done.id='ready';done.textContent=(final?'passed ':'FAILED-callback ')+JSON.stringify(out);
 document.body.append(done);
} catch(error) { const fail=document.createElement('p');fail.id='ready';fail.textContent='FAILED '+error.message;document.body.append(fail); }
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"draft editor keeps text, caret, selection and markup identical across the fixed input script",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-draft-equivalence-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			writeFileSync(join(root, "test.js"), editorJs);
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
				label: "Draft equivalence test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			const raw = page.text.slice(page.text.indexOf('id="ready">passed') + 'id="ready">passed'.length);
			const jsonText = raw
				.slice(0, raw.indexOf("</p>"))
				.replace(/&quot;/g, '"')
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">");
			const snaps = JSON.parse(jsonText) as string[];
			console.log(`DRAFT-EQUIV-SNAPS ${JSON.stringify(snaps)}`);
			expect(snaps).toEqual(EXPECTED_SNAPS);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);

/**
 * W206: the Composer tall/expand + suggestion-navigation contract. The ghost measure rewrite
 * (cached line height, ResizeObserver mounted once) must keep the expand button's exact
 * behaviour: hidden at 3 or fewer rows, shown beyond that, and the expanded editor still
 * opens/closes. Suggestion arrow navigation must keep the highlighted row in view.
 */
const composerJs = `
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {set,setView} from '/js/store.js';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=(c,m)=>{if(!c) throw Error(m);};
const area=()=>document.querySelector('.composer-input');
const expandBtn=()=>document.querySelector('.composer-expand');
let nonce=0;
const insert=(text)=>{nonce+=1;set({editorInsert:{text:text,replace:true,nonce:nonce}});};
const key=(k)=>area().dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
try {
 set({items:[],snap:{cwd:'C:/t',active:false,trust:{trusted:true},flags:{},session:{id:'w206',file:'C:/fixture/w206.jsonl'},thinking:{},run:{},queue:{},app:{}},
  surface:{widgets:{},statuses:{}},queue:{steering:[],followUp:[]},dialogs:[],
  resources:{commands:[{name:'help',description:'Show help',source:'builtin',uses:2},{name:'new',description:'New chat',source:'builtin',uses:1},{name:'compact',description:'Compact now',source:'builtin',uses:0},{name:'commit',description:'Commit work',source:'builtin',uses:0},{name:'push',description:'Push branch',source:'builtin',uses:0},{name:'undo',description:'Undo task',source:'builtin',uses:0},{name:'restore',description:'Restore files',source:'builtin',uses:0},{name:'diff',description:'Show diff',source:'builtin',uses:0},{name:'files',description:'List files',source:'builtin',uses:0},{name:'terminal',description:'Open terminal',source:'builtin',uses:0},{name:'setting',description:'Open settings',source:'builtin',uses:0},{name:'model',description:'Pick model',source:'builtin',uses:0}],tools:[],skills:[],templates:[],extensions:[]}});
 setView({lang:'en'});
 render(h(Composer,{}),document.getElementById('app'));
 await wait(300);
 // 1) three rows or fewer: no expand button.
 insert('one\\ntwo\\nthree');
 await wait(200);
 check(!expandBtn(),'expand button shows at exactly 3 rows');
 check(area().textContent==='onetwothree','three-row draft text wrong: '+JSON.stringify(area().textContent));
 // 2) a fourth row: the button appears; clicking it opens the large editor, Esc closes it.
 insert('one\\ntwo\\nthree\\nfour');
 await wait(200);
 check(!!expandBtn(),'expand button missing at 4 rows');
 check(expandBtn().getAttribute('aria-label')==='Expand the editor','expand aria-label wrong');
 expandBtn().click();
 await wait(200);
 check(!!document.querySelector('.composer.expanded'),'clicking expand does not open the large editor');
 check(expandBtn().getAttribute('aria-label')==='Collapse the editor','collapse aria-label wrong');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await wait(300);
 check(!document.querySelector('.composer.expanded'),'Esc does not close the large editor');
 // 3) back to two rows: the button goes away again.
 insert('one\\ntwo');
 await wait(200);
 check(!expandBtn(),'expand button stays after shrinking to 2 rows');
 // 4) suggestion navigation keeps the highlighted row in view, wrapping both ways.
 insert('/');
 await wait(200);
 const list=document.querySelector('.suggest:not(.closing)');
 check(!!list,'slash list never mounted');
 const rows=[...list.querySelectorAll('.suggest-item')];
 check(rows.length===12,'slash list should show the 12 stubbed commands, got '+rows.length);
 const visible=(row)=>{const t=row.offsetTop,b=t+row.offsetHeight;return t>=list.scrollTop&&b<=list.scrollTop+list.clientHeight;};
 const selIndex=()=>rows.findIndex(r=>r.getAttribute('aria-selected')==='true');
 check(selIndex()===0,'first row must start selected');
 area().focus();
 for(let i=0;i<11;i++){key('ArrowDown');await wait(20);}
 check(selIndex()===11,'ArrowDown x11 must reach the last row, at '+selIndex());
 check(visible(rows[11]),'last row not scrolled into view, scrollTop='+list.scrollTop);
 key('ArrowDown');await wait(40);
 check(selIndex()===0,'ArrowDown on the last row must wrap to the first, at '+selIndex());
 check(visible(rows[0]),'wrapping to the first row must scroll it into view, scrollTop='+list.scrollTop);
 key('ArrowUp');await wait(40);
 check(selIndex()===11,'ArrowUp on the first row must wrap to the last, at '+selIndex());
 check(visible(rows[11]),'wrapped last row not scrolled into view, scrollTop='+list.scrollTop);
 key('Escape');await wait(300);
 check(!document.querySelector('.suggest'),'Esc must dismiss the suggestion list');
 const done=document.createElement('p');done.id='ready';done.textContent='passed';
 document.body.append(done);
} catch(error) { const fail=document.createElement('p');fail.id='ready';fail.textContent='FAILED '+error.message;document.body.append(fail); }
`;

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"composer shows the expand button past three rows and keeps the navigated suggestion row in view",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-composer-tall-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.route("GET", "/api/state", () => ({
				items: [],
				session: { id: "w206", file: "C:/fixture/w206.jsonl" },
				app: {},
				flags: {},
				thinking: {},
				trust: { trusted: true },
				surface: { widgets: {}, statuses: {} },
				queue: { steering: [], followUp: [] },
				run: {},
			}));
			server.route("GET", "/api/resources", () => ({
				commands: [],
				contextFiles: [],
				tools: [],
				skills: [],
				templates: [],
				extensions: [],
			}));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/modes/state", () => ({
				state: { lastSessionFile: null, model: null, drafts: {} },
			}));
			writeFileSync(join(root, "test.js"), composerJs);
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/composer.css"><div style="height:420px"></div><div id="app" style="height:420px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			server.mount({ prefix: "/test/", directory: root });
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Composer tall test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);
