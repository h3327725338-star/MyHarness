import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"points fold arrows right then down, lets blank chats that were left leave, keeps a typed name safe and fades overlays and toasts in a real browser",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-experience-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const now = Date.now();
		// A chat as the server lists it; `blank` chats hold nothing but the setup written at creation.
		const chat = (id: string, modified: number, extra: Record<string, unknown> = {}) => ({
			path: `C:/fixture/${id}.jsonl`,
			id,
			name: "",
			modified,
			firstMessage: id,
			messageCount: 1,
			...extra,
		});
		const blank = (id: string, modified: number) =>
			chat(id, modified, { firstMessage: "", messageCount: 0, blank: true });
		const renames: { path: string; title: string }[] = [];
		let workspaceReads = 0;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			// The first read of the Workspaces is slow and empty; later reads find one workspace.
			server.route("GET", "/api/workspaces", async () => {
				workspaceReads += 1;
				if (workspaceReads === 1) await new Promise((resolve) => setTimeout(resolve, 700));
				return {
					workspaces:
						workspaceReads === 1 ? [] : [{ id: "w1", rootPath: "C:/fixture/proj", name: "proj", current: false }],
					currentPath: null,
					currentSessionFile: null,
				};
			});
			server.route("GET", "/api/workspaces/sessions", () => ({
				sessions: [chat("p1", now - 5000, { name: "Chat p1" })],
			}));
			server.route("GET", "/api/sessions/unbound", () => ({
				sessions: [
					blank("a", now - 1000),
					chat("b", now - 2000, { name: "Chat b" }),
					blank("d", now - 3000),
					blank("t", now - 4000),
					chat("c", now - 6000, { name: "Chat c" }),
				],
			}));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [blank("z", now - 9000)] }));
			server.route("POST", "/api/sessions/rename", ({ body }) => {
				renames.push(body as { path: string; title: string });
				return { ok: true };
			});
			server.route("GET", "/api/test/renames", () => ({ renames }));
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/transcript", () => ({ items: [] }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="side" style="width:280px;height:600px;display:flex;flex-direction:column"></div><div id="folds"></div><div id="ov"></div><div id="tz" style="position:relative;width:600px;height:400px"></div><img src="/hold" hidden><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {Toasts} from '/js/app.js';
import {Icon,Fold,Modal,Overlay} from '/js/ui.js';
import {dismissToast,loadWorkspaces,set,setView,state,toast} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(ok,message)=>{ if(!ok) throw Error(message); };
const side=document.getElementById('side');
// What was seen going away or coming in, whatever the timing: a folding area loses "open" while it is still in the page.
const seen=new Set();
new MutationObserver(records=>{
 for(const r of records){
  const el=r.target; if(el.nodeType!==1) continue;
  const was=(r.oldValue||'').split(/\\s+/);
  const key=(el.closest('.chat-slot')||{dataset:{}}).dataset.path||el.textContent.trim().slice(0,30);
  if(el.classList.contains('open')&&!was.includes('open')) seen.add('opening:'+key);
  if(!el.classList.contains('open')&&was.includes('open')) seen.add('closing:'+key);
  if(el.classList.contains('closing')||el.classList.contains('leaving')) seen.add('fading:'+el.className.trim());
 }
}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});
const angle=el=>{const t=getComputedStyle(el).transform;const m=new DOMMatrix(t==='none'?undefined:t);return Math.round(Math.atan2(m.b,m.a)*180/Math.PI);};
const slotOf=path=>side.querySelector('.chat-slot[data-path="'+path+'"]');
const rowOf=path=>slotOf(path)&&slotOf(path).querySelector('.chat-row');
const current=file=>set({snap:{session:{file,id:file.split('/').pop().replace('.jsonl','')}}});
const draftOf=text=>({coding:{lastSessionFile:null,drafts:text===null?{}:{d:{text,attachments:[]}}},general:{lastSessionFile:null,drafts:{}}});
try {
 document.documentElement.dataset.motion='on';
 setView({lang:'en',motion:'on',expanded:{'<general>':true},expandedGeneral:{}});
 // The chat on screen is a blank one; "d" holds a draft, "t" is open with something typed in it.
 set({snap:{session:{file:'C:/fixture/a.jsonl',id:'a'}},modeState:draftOf('half-written'),slots:[{slot:'st',sessionFile:'C:/fixture/t.jsonl',sessionId:'t',unbound:true,hasContent:true}]});

 // 1. Workspaces that were not read yet are not reported as missing; an empty list that was read is.
 const first=loadWorkspaces();
 render(h(Sidebar),side); await wait(300);
 must(!side.textContent.includes('No workspaces'),'No workspaces was shown before the list was read');
 await first; await wait(300);
 must(side.textContent.includes('No workspaces'),'an empty list of Workspaces is not reported');
 must(seen.has('opening:No workspaces'),'the note did not fold in');

 // 2. A Workspace that is added grows in and the note folds away; the arrow of a closed group points right.
 await loadWorkspaces(); await wait(500);
 const proj=side.querySelector('.ws-row[title="C:/fixture/proj"]');
 must(proj,'the new Workspace did not appear');
 must(seen.has('closing:No workspaces'),'the note did not fold away');
 must(!side.textContent.includes('No workspaces'),'the note stayed after a Workspace arrived');
 must(seen.has('opening:C:/fixture/proj')||[...seen].some(key=>key.startsWith('opening:proj')),'the Workspace did not grow in');
 must(proj.getAttribute('aria-expanded')==='false' && angle(proj.querySelector('.chev'))===0,'closed group arrow is not pointing right: '+angle(proj.querySelector('.chev')));
 proj.click(); await wait(450);
 must(proj.getAttribute('aria-expanded')==='true' && angle(proj.querySelector('.chev'))===90,'open group arrow is not pointing down: '+angle(proj.querySelector('.chev')));
 must(side.textContent.includes('Chat p1'),'the open Workspace shows no chats');
 const archive=[...side.querySelectorAll('.ws-row')].find(r=>r.textContent.includes('Archive'));
 must(archive.getAttribute('aria-expanded')==='false' && angle(archive.querySelector('.chev'))===0,'Archive arrow is not pointing right');

 // 3. The other fold controls: the arrow is the same right-pointing glyph, turned a quarter by aria-expanded.
 const glyph=(name)=>h(Icon,{name:'chevronRight',size:13,class:name});
 render(h('div',null,
  h('button',{id:'f1','aria-expanded':'false'},h(Fold)),h('button',{id:'f2','aria-expanded':'true'},h(Fold)),
  h('button',{id:'d1','aria-expanded':'false'},glyph('disclose')),h('button',{id:'d2','aria-expanded':'true'},glyph('disclose'))),document.getElementById('folds'));
 await wait(450);
 for(const [id,deg] of [['f1',0],['f2',90],['d1',0],['d2',90]]){
  const svg=document.querySelector('#'+id+' svg');
  must(svg.querySelector('path').getAttribute('d')==='m9 6 6 6-6 6','fold glyph is not a right arrow: '+id);
  must(angle(svg)===deg,'fold arrow '+id+' is at '+angle(svg)+' degrees, not '+deg);
 }

 // 4. A saved blank chat that was left behind folds away; one that holds anything stays.
 const kept=()=>['a','b','c','d','t'].filter(id=>slotOf('C:/fixture/'+id+'.jsonl')).join(',');
 must(kept()==='a,b,c,d,t','initial rows: '+kept());
 current('C:/fixture/b.jsonl'); await wait(700);
 must(seen.has('closing:C:/fixture/a.jsonl'),'the blank chat did not fold away');
 must(kept()==='b,c,d,t','after leaving the blank chat: '+kept()+' (draft and typed-in chats stay)');
 // The draft goes: the chat that held it is blank and left behind, like the first one. A whitespace-only draft is no draft.
 set({modeState:draftOf('  \\n ')}); await wait(700);
 must(kept()==='b,c,t','a chat with an empty draft stayed: '+kept());
 // The open chat is closed: nothing keeps "t" any more.
 set({slots:[]}); await wait(700);
 must(kept()==='b,c','a closed blank chat stayed: '+kept());
 // Coming back to the first one lists it again, as the chat on screen, and leaving again removes it again.
 current('C:/fixture/a.jsonl'); await wait(500);
 must(kept()==='a,b,c' && seen.has('opening:C:/fixture/a.jsonl'),'the chat on screen is not listed: '+kept());
 current('C:/fixture/b.jsonl'); await wait(700);
 must(kept()==='b,c','the blank chat did not leave a second time: '+kept());
 // With animations off the row is out of sight at once (the page keeps it a moment longer, folded).
 document.documentElement.dataset.motion='off';
 current('C:/fixture/a.jsonl'); await wait(300);
 current('C:/fixture/b.jsonl'); await wait(80);
 must(!slotOf('C:/fixture/a.jsonl')||slotOf('C:/fixture/a.jsonl').getBoundingClientRect().height<2,'a left-behind chat is still seen although animations are off');
 await wait(500);
 document.documentElement.dataset.motion='on';
 // What was archived on purpose is always listed.
 setView({expanded:{...state.view.expanded,'<archived>':true}}); await wait(500);
 must(slotOf('C:/fixture/z.jsonl'),'an archived blank chat is not listed');
 must(angle(archive.querySelector('.chev'))===90,'Archive arrow did not turn down');

 // 5. Escape leaves the name as it was (the box that closes also loses focus, which must not save what was typed); Enter saves it.
 const rename=async(key,text)=>{
  const row=rowOf('C:/fixture/b.jsonl');
  row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); await wait(60);
  const input=row.querySelector('input.title-edit'); must(input,'the rename box did not open');
  input.focus(); input.value=text; input.dispatchEvent(new Event('input',{bubbles:true})); await wait(30);
  input.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})); await wait(200);
  must(!row.querySelector('input'),key+' did not close the rename box');
 };
 const saved=async()=>(await (await fetch('/api/test/renames')).json()).renames;
 await rename('Escape','Chat b typed then cancelled');
 must((await saved()).length===0,'Escape saved the name that was typed: '+JSON.stringify(await saved()));
 await rename('Enter','Chat b renamed');
 const after=await saved();
 must(after.length===1 && after[0].title==='Chat b renamed','Enter did not save the name: '+JSON.stringify(after));

 // 6. A dialog fades out with the page behind it already usable, keeps out of the way while it does, and gives the focus back.
 const ov=document.getElementById('ov');
 const opener=document.createElement('button'); opener.id='opener'; opener.textContent='open'; document.body.append(opener); opener.focus();
 let closes=0,escapes=0;
 document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') escapes+=1; });
 const escape=()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 render(h(Overlay,{show:true},h(Modal,{title:'Hello',onClose(){closes+=1;}},h('input',{id:'name',class:'field'}))),ov); await wait(150);
 must(ov.querySelector('.overlay-host')&&!ov.querySelector('.overlay-host.closing'),'the dialog did not open');
 must(document.activeElement&&document.activeElement.id==='name','the dialog did not take the focus');
 escape(); must(closes===1&&escapes===0,'an open dialog does not answer Escape: '+closes+'/'+escapes);
 render(h(Overlay,{show:false},null),ov); await wait(40);
 const host=ov.querySelector('.overlay-host');
 must(host&&host.classList.contains('closing'),'the dialog went away without fading out');
 must(host.hasAttribute('inert'),'a fading dialog still takes clicks and keys');
 escape(); must(closes===1&&escapes===1,'a fading dialog still takes Escape: '+closes+'/'+escapes);
 must(ov.querySelector('.modal'),'the dialog lost its content while fading out');
 await wait(450);
 must(!ov.querySelector('.overlay-host'),'the dialog did not leave');
 must(document.activeElement===opener,'the focus was not given back to the opener');
 // Without motion it leaves at once.
 document.documentElement.dataset.motion='off';
 render(h(Overlay,{show:true},h(Modal,{title:'Hello',onClose(){}},h('input',{id:'name',class:'field'}))),ov); await wait(100);
 render(h(Overlay,{show:false},null),ov); await wait(60);
 must(!ov.querySelector('.overlay-host'),'the dialog fades although animations are off');
 document.documentElement.dataset.motion='on';

 // 7. A dismissed toast folds away and the one below moves up with it instead of jumping.
 const tz=document.getElementById('tz');
 render(h(Toasts),tz);
 toast('first toast','info',0); toast('second toast','info',0); await wait(400);
 const toasts=()=>[...tz.querySelectorAll('.toast')].map(el=>el.textContent.trim());
 must(toasts().length===2,'toasts: '+toasts());
 const second=[...tz.querySelectorAll('.toast')].find(el=>el.textContent.includes('second'));
 const top0=second.getBoundingClientRect().top;
 dismissToast(state.toasts[0].id); await wait(30);
 must(toasts().length===2,'the toast vanished instead of folding away');
 const tops=[];
 for(let i=0;i<24;i++){ await wait(16); tops.push(second.getBoundingClientRect().top); }
 must(seen.has('closing:first toast')||[...seen].some(key=>key.startsWith('closing:first')),'the toast did not fold away');
 must(tops.at(-1)<top0-10,'the toast below did not move up: '+tops);
 must(tops.every((value,i)=>!i||value<=tops[i-1]+0.5),'the toast below moved back down: '+tops);
 await wait(500);
 must(toasts().length===1 && toasts()[0].includes('second'),'the dismissed toast did not leave: '+toasts());
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Experience polish",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
