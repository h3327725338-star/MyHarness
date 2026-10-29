import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The built-in browser's downloads list, in real Chromium with a recording desktop host:
 *
 * - the toolbar has a downloads button where the new-tab "+" was (the tab strip keeps its own "+");
 * - a download that starts makes the button show a filling bar, and no notice strip appears over the toolbar;
 * - the list shows each file with its status ("Completed — 2.7 KB", "1.0 MB / 4.0 MB", "File moved or deleted"), opens a
 *   finished file on click, shows it in its folder, cancels a running one and retries one whose file is gone;
 * - the footer opens the Downloads folder and clears the list; Escape closes it; a download that ends while the list is
 *   closed leaves a dot on the button until the list is opened again.
 */
it.skipIf(!installed.length)(
	"browser downloads button and list",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-downloads-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
			// Runs in the plain unit suite too: headless, never a window pulled to the front.
			unattended: true,
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/web-prefs", () => ({ prefs: null }));
			server.route("PUT", "/api/web-prefs", () => ({ ok: true }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><div id="app" style="position:fixed;inset:0;display:flex;flex-direction:column"></div><script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message))});setTimeout(function(){if(!document.getElementById("ready"))document.body.insertAdjacentHTML("beforeend","<p id=\\"ready\\">FAILED module did not finish; step="+(window.__step||"import")+" errors="+window.__errors.join(" / ")+"</p>")},25000)</script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
window.__errors=window.__errors||[];
window.addEventListener('error',event=>window.__errors.push(String(event.message)));
import {h,render} from '/vendor/preact.js';
import {BrowserPanel} from '/js/panel-browser.js';
import {setView} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const mark=step=>{window.__step=step};
const until=async(fn,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(15)}return false};
const calls=[];
const listeners=new Set();
const FOLDER='C:\\\\Users\\\\me\\\\Downloads';
let list=[
	{id:'download1',seq:1,name:'notes.txt',savePath:FOLDER+'\\\\notes.txt',url:'https://files.example/notes.txt',total:2765,received:2765,state:'completed',at:1},
	{id:'download2',seq:2,name:'gone.pdf',savePath:FOLDER+'\\\\gone.pdf',url:'https://files.example/gone.pdf',total:5000,received:5000,state:'completed',missing:true,at:2},
];
window.myHarnessDesktop={
	browser:async command=>{
		calls.push(JSON.parse(JSON.stringify(command)));
		if(command.action==='downloads')return {folder:FOLDER,downloads:list};
		if(command.action==='downloads-clear'){list=list.filter(entry=>entry.state==='progressing');return {ok:true};}
		if(command.action==='download-icon')return {icon:''};
		if(command.action==='bookmarks')return {bookmarks:[]};
		if(command.action==='speeddial')return {items:[]};
		if(command.action==='state')return {tabId:command.tabId,url:'https://site.example/',title:'Site',loading:false,error:'',canGoBack:false,canGoForward:false};
		if(command.action==='ensure')return {tabId:command.tabId,url:command.url,loading:false};
		if(command.action==='permissions')return {permissions:[],pending:[]};
		return {ok:true};
	},
	openPath:async target=>{calls.push({action:'openPath',target});return null},
	revealPath:async target=>{calls.push({action:'revealPath',target});return {ok:true}},
	external:async()=>{},
	onStatus:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
	onWorkspace:()=>()=>{},replyWorkspace:async()=>({ok:true}),
};
const emit=value=>{for(const listener of [...listeners])listener(value)};
// The host reports a step and lists the download the same way (running ones after the finished ones).
const report=record=>{list=[...list.filter(entry=>entry.id!==record.id),{...record,state:record.state==='started'?'progressing':record.state}];emit({type:'download',tabId:'browser:a',...record});};
const SEB={id:'download3',seq:3,name:'SEB_Setup.exe',savePath:FOLDER+'\\\\SEB_Setup.exe',url:'https://files.example/seb.exe',total:4*1024*1024};
const button=()=>document.querySelector('.ws-dl-button');
const rows=()=>[...document.querySelectorAll('.ws-downloads .ws-dl-row')];
const row=name=>rows().find(r=>r.querySelector('.ws-dl-name').textContent===name);
const status=name=>row(name)?.querySelector('.ws-dl-status').textContent;
const did=action=>calls.filter(c=>c.action===action);
try {
	mark('toolbar');
	setView({panelOpen:true,wsTabs:[{id:'browser:a',type:'browser',url:'https://site.example/'}],wsActive:'browser:a'});
	render(h(BrowserPanel,{tabId:'browser:a',url:'https://site.example/'}),document.getElementById('app'));
	check(await until(()=>!!button()),'there is no downloads button');
	// The list is read right after the panel starts listening to the host.
	check(await until(()=>did('downloads').length>0),'the list was never read from the host');
	const toolbar=[...document.querySelector('.ws-browser-bar').children];
	const at=toolbar.indexOf(button());
	check(toolbar[at-1]?.classList.contains('ws-star'),'the downloads button is not right after the star');
	check(!document.querySelector('.ws-browser-bar [aria-label="New browser tab"]'),'the toolbar still has the new-tab plus');

	mark('start');
	report({...SEB,received:0,state:'started'});
	report({...SEB,received:1024*1024,state:'progressing'});
	check(await until(()=>button().classList.contains('running')&&!!button().querySelector('.ws-dl-progress > span')),'the button does not show a running download');
	check(button().querySelector('.ws-dl-progress > span').style.width==='25%','the bar is not a quarter full: '+button().querySelector('.ws-dl-progress > span').style.width);
	check(!!button().querySelector('.ws-dl-arrow.drop'),'the arrow did not drop for the new download');
	await wait(100);
	check(!document.querySelector('.ws-notice'),'a notice strip still appears for a download');

	mark('list');
	button().click();
	check(await until(()=>rows().length===3),'the list does not show 3 downloads: '+rows().length);
	check(rows()[0].querySelector('.ws-dl-name').textContent==='SEB_Setup.exe','the newest download is not first');
	check(status('SEB_Setup.exe').startsWith('1.0 MB / 4.0 MB'),'running status: '+status('SEB_Setup.exe'));
	check(!!row('SEB_Setup.exe').querySelector('.ws-dl-bar > span'),'the running row has no bar');
	check(status('notes.txt')==='Completed — 2.7 KB','finished status: '+status('notes.txt'));
	check(status('gone.pdf')==='File moved or deleted','missing status: '+status('gone.pdf'));
	check(row('gone.pdf').querySelector('.ws-dl-main').disabled,'a missing file can still be opened');

	mark('actions');
	row('notes.txt').querySelector('.ws-dl-main').click();
	check(await until(()=>did('openPath').some(c=>c.target===FOLDER+'\\\\notes.txt')),'clicking a finished file did not open it');
	row('notes.txt').querySelector('.ws-dl-act').click();
	check(await until(()=>did('revealPath').some(c=>c.target===FOLDER+'\\\\notes.txt')),'the folder button did not show the file');
	row('SEB_Setup.exe').querySelector('.ws-dl-act').click();
	check(await until(()=>did('download-cancel').some(c=>c.id==='download3')),'the cancel button did not cancel');
	row('gone.pdf').querySelector('.ws-dl-act').click();
	check(await until(()=>did('download-retry').some(c=>c.id==='download2'&&c.tabId==='browser:a')),'the retry button did not retry in this tab');
	document.querySelector('.ws-dl-foot .btn').click();
	check(await until(()=>did('openPath').some(c=>c.target===FOLDER)),'the folder button did not open the Downloads folder');

	mark('close');
	window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
	check(await until(()=>!document.querySelector('.ws-downloads')),'Escape did not close the list');
	report({...SEB,received:4*1024*1024,state:'completed',at:3});
	check(await until(()=>!button().classList.contains('running')&&!!button().querySelector('.ws-dl-mark')),'a finished download left no mark on the button');
	button().click();
	check(await until(()=>status('SEB_Setup.exe')==='Completed — 4.0 MB'),'the finished download is not listed as completed: '+status('SEB_Setup.exe'));
	check(!button().querySelector('.ws-dl-mark'),'opening the list did not clear the mark');

	mark('clear');
	[...document.querySelectorAll('.ws-dl-foot .btn')].at(-1).click();
	check(await until(()=>did('downloads-clear').length===1&&!!document.querySelector('.ws-dl-empty')),'clearing did not empty the list');
	check(window.__errors.length===0,'page errors: '+window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">FAILED '+(window.__step||'')+': '+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Downloads",
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
