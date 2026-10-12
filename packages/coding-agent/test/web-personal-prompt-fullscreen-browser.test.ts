import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"personal prompt cards stay unwrapped and the fullscreen editor syncs, owns Esc and returns focus",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "personal-fullscreen-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installed[0]!.kind, rootDir: join(root, "browser") });
		let lastPost: unknown = null;
		const saved = { coding: "start coding", general: "start general" };
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {set,setView,useStore} from '/js/store.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const $=sel=>document.querySelector(sel);
const $$=sel=>[...document.querySelectorAll(sel)];
function need(cond,msg){ if(!cond) throw Error(msg); }
function setArea(ta,text){ const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta,text); ta.dispatchEvent(new Event('input',{bubbles:true})); }
function esc(composing){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:composing===true})); }
function tab(){ return new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}); }
// Host mirrors the real app: the settings dialog unmounts when its store flag goes false (that is how the second Esc becomes observable).
function Host(){ return useStore(s=>s.view.settingsOpen)? h(SettingsModal):null; }
try {
 set({snap:{session:{id:'test'},active:false},items:[]});
 setView({settingsOpen:true,settingsSection:'personal'});
 render(h(Host),app);
 await wait(400);
 need($$('.settings-body .set-card').length===2,'two personal cards expected');
 // (1) no nested card bodies; expand both cards first
 need(!$$('.settings-body .set-card .set-card-toggle').some(tg=>tg.getAttribute('aria-expanded')==='true'),'cards must start folded');
 for(const tg of $$('.settings-body .set-card .set-card-toggle')){ tg.click(); await wait(360); }
 need($$('.set-card-body .set-card-body').length===0,'a .set-card-body still nests another one');
 const cards=$$('.settings-body .set-card');
 for(const card of cards){
  const ta=card.querySelector('textarea.personal-prompt');
  need(ta,'missing prompt textarea in card');
  const gap=card.getBoundingClientRect().width-ta.getBoundingClientRect().width;
  need(gap<=40,'one-sided whitespace too large: card minus textarea = '+gap);
 }
 // (2) maximize button opens the fullscreen editor with the focus inside
 const codingCard=cards[0], generalCard=cards[1];
 const codingBtn=codingCard.querySelector('.personal-expand-btn');
 const generalBtn=generalCard.querySelector('.personal-expand-btn');
 need(codingBtn&&generalBtn,'expand buttons missing');
 need(codingBtn.getAttribute('aria-label')==='Edit fullscreen','button aria-label wrong: '+codingBtn.getAttribute('aria-label'));
 codingBtn.focus(); codingBtn.click(); await wait(320);
 const scrim=$('.personal-fullscreen-scrim');
 need(scrim,'clicking the maximize button did not open the scrim');
 need(getComputedStyle(scrim).zIndex==='220','scrim z-index is not 220: '+getComputedStyle(scrim).zIndex);
 const dialog=$('.personal-fullscreen-dialog');
 need(dialog&&dialog.getAttribute('role')==='dialog'&&dialog.getAttribute('aria-modal')==='true','fullscreen dialog role/aria-modal missing');
 need(dialog.getAttribute('aria-label')==='Coding mode global personal prompt','dialog title wrong: '+dialog.getAttribute('aria-label'));
 const big=$('.personal-fullscreen-textarea');
 need(document.activeElement===big,'the large textarea did not take focus');
 need(big.value==='start coding','large box does not share the draft: '+big.value);
 // caret/selection inherited from the small box
 $('.personal-fullscreen-close').click(); await wait(250);
 const small=codingCard.querySelector('textarea.personal-prompt');
 need(small.value==='start coding','small box lost the value on close');
 small.focus(); small.setSelectionRange(3,7);
 codingBtn.click(); await wait(320);
 const big2=$('.personal-fullscreen-textarea');
 need(big2.selectionStart===3&&big2.selectionEnd===7,'selection was not inherited: '+big2.selectionStart+'..'+big2.selectionEnd);
 // font and line height match the small field
 const s1=getComputedStyle(small), s2=getComputedStyle(big2);
 need(s1.lineHeight===s2.lineHeight&&s1.fontFamily===s2.fontFamily,'fullscreen editor font/line-height differs from the small box');
 // (3) two-way sync, coding: large -> small, reopen keeps it, small -> large
 setArea(big2,'coding edited A'); await wait(150);
 need(small.value==='coding edited A','small box did not follow the large one live');
 // Tab stays inside the dialog
 big2.dispatchEvent(tab()); await wait(30);
 need(document.activeElement===$('.personal-fullscreen-close'),'Tab left the dialog (textarea -> button)');
 $('.personal-fullscreen-close').dispatchEvent(tab()); await wait(30);
 need(document.activeElement===$('.personal-fullscreen-textarea'),'Tab left the dialog (button -> textarea)');
 $('.personal-fullscreen-close').click(); await wait(250);
 need(!$('.personal-fullscreen-scrim'),'close button did not close the editor');
 need(document.activeElement===codingBtn,'focus did not return to the maximize button');
 need(small.value==='coding edited A','small box value lost after close');
 codingBtn.click(); await wait(320);
 need($('.personal-fullscreen-textarea').value==='coding edited A','reopen did not show the synced value');
 $('.personal-fullscreen-scrim').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); await wait(250);
 need(!$('.personal-fullscreen-scrim'),'scrim click did not close the editor');
 setArea(small,'coding edited B'); await wait(150);
 codingBtn.click(); await wait(320);
 need($('.personal-fullscreen-textarea').value==='coding edited B','small-box edit did not reach the large box');
 $('.personal-fullscreen-close').click(); await wait(250);
 // general mode keeps its own draft
 generalBtn.focus(); generalBtn.click(); await wait(320);
 const bigGen=$('.personal-fullscreen-textarea');
 need($('.personal-fullscreen-dialog').getAttribute('aria-label')==='General mode global personal prompt','general dialog title wrong');
 need(bigGen.value==='start general','general large box shows the wrong draft: '+bigGen.value);
 setArea(bigGen,'general edited'); await wait(150);
 $('.personal-fullscreen-close').click(); await wait(250);
 need(generalCard.querySelector('textarea.personal-prompt').value==='general edited','general sync broken');
 // (4) Esc closes only the fullscreen layer; IME-composition Esc closes nothing
 codingBtn.focus(); codingBtn.click(); await wait(320);
 esc(true); await wait(120);
 need($('.personal-fullscreen-scrim'),'Esc during an IME composition closed the editor');
 esc(false); await wait(300);
 need(!$('.personal-fullscreen-scrim'),'first Esc did not close the fullscreen editor');
 need($('.settings-modal'),'first Esc closed the settings modal');
 need(document.activeElement===codingBtn,'Esc did not return focus to the maximize button');
 esc(false); await wait(300);
 need(!$('.settings-modal'),'second Esc did not close the settings modal');
 // reopen for the save check
 setView({settingsOpen:true}); await wait(400);
 for(const tg of $$('.settings-body .set-card .set-card-toggle')){ if(tg.getAttribute('aria-expanded')!=='true'){ tg.click(); await wait(360); } }
 const codingBtn2=$$('.settings-body .set-card')[0].querySelector('.personal-expand-btn');
 codingBtn2.click(); await wait(320);
 setArea($('.personal-fullscreen-textarea'),'final coding text'); await wait(150);
 $('.personal-fullscreen-close').click(); await wait(250);
 // (5) Save posts the fullscreen edit and clears dirty
 const saveBtn=$('.personal-foot .btn.primary');
 need(!saveBtn.disabled,'save button not enabled after the edit');
 saveBtn.click(); await wait(500);
 const posted=await (await fetch('/api/last-post')).json();
 need(posted&&posted.body&&posted.body.coding==='final coding text','POST body lost the fullscreen edit: '+JSON.stringify(posted));
 need($('.personal-foot .btn.primary').disabled,'dirty was not cleared after save');
 need(!$$('.personal-foot button').some(b=>b.textContent.trim()==='Discard changes'),'discard button still visible after save');
 // (6) the appearance page card padding is untouched by this change
 $$('.settings-nav button').find(b=>b.textContent.includes('Appearance')).click(); await wait(350);
 const pads=$$('.settings-body .set-card-body').map(el=>{const s=getComputedStyle(el);return s.paddingTop+' '+s.paddingRight+' '+s.paddingBottom+' '+s.paddingLeft;});
 need(pads.length>0,'no appearance cards found');
 for(const p of pads) need(p==='0px 16px 0px 16px','appearance .set-card-body padding changed: '+p);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { const p=document.createElement('p'); p.id='ready'; p.textContent=error.message+' | '+error.stack; document.body.append(p); }
`,
			);
			server.route("GET", "/api/settings", () => ({ items: [] }));
			server.route("GET", "/api/models", () => ({ models: [], providers: [] }));
			server.route("GET", "/api/modes/personal-prompt", () => saved);
			server.route("POST", "/api/modes/personal-prompt", (ctx) => {
				const body = ctx.body as { coding?: string; general?: string };
				lastPost = { coding: body.coding, general: body.general };
				if (typeof body.coding === "string") saved.coding = body.coding;
				if (typeof body.general === "string") saved.general = body.general;
				return saved;
			});
			server.route("GET", "/api/last-post", () => ({ body: lastPost }));
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Personal prompt fullscreen test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120_000,
);
