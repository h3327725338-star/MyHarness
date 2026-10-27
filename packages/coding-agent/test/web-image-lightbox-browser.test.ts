import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"opens the image lightbox from composer thumbnails and message images, the × only removes",
	async () => {
		const base = process.env.MYHARNESS_TEMP_DIR || tmpdir();
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "image-lightbox-"));
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
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/transcript.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Composer} from '/js/composer.js';
import {Transcript} from '/js/transcript.js';
import {ImageLightboxHost} from '/js/lightbox.js';
import {set,setView} from '/js/store.js';
const app=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const $=sel=>document.querySelector(sel);
function need(cond,msg){ if(!cond) throw Error(msg); }
function key(el,k){ el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true})); }
async function closeLightbox(mode){
 const scrim=$('.lightbox-scrim'); need(scrim,'no scrim to close via '+mode);
 if(mode==='scrim') scrim.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
 if(mode==='button') $('.lightbox-close').click();
 if(mode==='esc') window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 await wait(260);
 need(!$('.lightbox-scrim'),'scrim still present after '+mode);
}
async function attachImage(name){
 const bin=atob(PNG); const bytes=new Uint8Array(bin.length);
 for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
 const ev=new Event('paste',{bubbles:true,cancelable:true});
 ev.clipboardData={files:[new File([bytes],name,{type:'image/png'})]};
 $('.composer-input').dispatchEvent(ev);
 await wait(300);
 need($('.attachments .thumb img'),'attachment thumbnail did not appear');
}
try {
 set({snap:{active:false,trust:{trusted:true},cwd:'C:/test',flags:{},queue:{steering:[],followUp:[]},model:null,session:{id:'test',persisted:true},thinking:{supported:false,levels:[]}},dialogs:[],runs:{},toolRuns:{},userBash:{},userBashOrder:[],items:[
  {kind:'user',id:'u1',ts:1,text:'with image',images:[{mimeType:'image/png',data:PNG}]},
  {kind:'assistant',id:'a1',ts:2,final:true,stopReason:'stop',blocks:[{type:'toolCall',id:'c1',name:'read',args:{path:'C:/test/x.png'}}]},
  {kind:'toolResult',id:'r1',ts:3,toolCallId:'c1',content:'read done',details:{},images:[{mimeType:'image/png',data:PNG}]}
 ]});
 setView({processDefault:'expanded'});
 render(h('div',null,h(Transcript,{}),h(Composer,{}),h(ImageLightboxHost,{})),app);
 await wait(250);
 // (4) message stream: the user's attached image opens the lightbox and closes again
 const uimg=$('.user-images img'); need(uimg,'no .user-images img');
 need(uimg.getAttribute('role')==='button' && uimg.tabIndex===0,'user image not keyboard reachable');
 need((uimg.getAttribute('src')||'').startsWith('data:'),'user image src is not an inline data URL');
 uimg.click(); await wait(260);
 need($('.lightbox-scrim'),'user image click did not open the lightbox');
 need($('.lightbox-img').getAttribute('src')===uimg.getAttribute('src'),'user image src mismatch');
 await closeLightbox('esc');
 // (4) message stream: the tool result image does the same
 const row=$('.action-row'); need(row,'no action row to open raw details');
 row.click(); await wait(420);
 const timg=$('.raw-images img'); need(timg,'no .raw-images img');
 need(timg.getAttribute('role')==='button' && timg.tabIndex===0,'tool image not keyboard reachable');
 timg.click(); await wait(260);
 need($('.lightbox-scrim'),'tool image click did not open the lightbox');
 need($('.lightbox-img').getAttribute('src')===timg.getAttribute('src'),'tool image src mismatch');
 await closeLightbox('button');
 // (1) composer thumbnail: click opens the lightbox with the same src
 need(!$('.lightbox-scrim'),'scrim already present before attach');
 await attachImage('shot-1.png');
 const thumb=$('.attachments .thumb');
 need(thumb.getAttribute('role')==='button' && thumb.tabIndex===0,'thumb not keyboard reachable');
 need((thumb.getAttribute('aria-label')||'').includes('shot-1.png'),'thumb aria-label missing');
 thumb.focus(); thumb.click(); await wait(260);
 need($('.lightbox-scrim'),'thumb click did not open the lightbox');
 need($('.lightbox-img').getAttribute('src')===$('.attachments .thumb img').getAttribute('src'),'thumb src mismatch');
 // (3) the three exits, each once, with the focus back on the thumbnail
 await closeLightbox('scrim');
 need(document.activeElement===thumb,'focus did not return to the thumb (scrim exit)');
 thumb.click(); await wait(260); need($('.lightbox-scrim'),'reopen for the button exit');
 await closeLightbox('button');
 need(document.activeElement===thumb,'focus did not return to the thumb (button exit)');
 thumb.click(); await wait(260); need($('.lightbox-scrim'),'reopen for the esc exit');
 await closeLightbox('esc');
 need(document.activeElement===thumb,'focus did not return to the thumb (esc exit)');
 // (2) the × strictly removes: no attachment left, no lightbox opened
 $('.thumb-x').click(); await wait(300);
 need(!$('.lightbox-scrim'),'× opened the lightbox');
 need(!$('.attachments'),'× did not remove the attachment');
 // (5) keyboard: Enter on the thumbnail opens; Enter on the × only removes
 await attachImage('shot-2.png');
 const thumb2=$('.attachments .thumb'); thumb2.focus(); key(thumb2,'Enter'); await wait(260);
 need($('.lightbox-scrim'),'Enter on the thumb did not open the lightbox');
 await closeLightbox('esc');
 const x=$('.thumb-x'); x.focus(); key(x,'Enter'); await wait(260);
 need(!$('.lightbox-scrim'),'Enter bubbling from the × opened the lightbox');
 x.click(); // what the browser's own Enter activation does on a focused button
 await wait(300);
 need(!$('.lightbox-scrim'),'× activation opened the lightbox');
 need(!$('.attachments'),'Enter on the × did not remove the attachment');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { const p=document.createElement('p'); p.id='ready'; p.textContent=error.stack; document.body.append(p); }
`,
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Image lightbox wiring",
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
