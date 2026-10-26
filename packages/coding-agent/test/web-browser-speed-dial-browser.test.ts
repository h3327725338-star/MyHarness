import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The built-in browser's new-tab page and tab strip, in real Chromium with a recording desktop host:
 *
 * - an empty website tab shows the host's shortcuts as a centred grid with an add tile;
 * - dropping one shortcut on the middle of another sends a layout with a group of both; the group opens in place and
 *   can be renamed; right-click deletes; a click opens the site in this tab; the add tile saves a typed address;
 * - website tabs can be shown by their site icon alone, toggled from the tab menu;
 * - a site icon reported for a tab that is not on screen reaches the tab strip.
 */
it.skipIf(!installed.length)(
	"new-tab shortcuts, groups, icon-only website tabs and background tab icons",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-speed-dial-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
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
import {WorkspaceTabs} from '/js/workspace-tabs.js';
import {installWorkspaceHost} from '/js/workspace-host.js';
import {setView,state} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const mark=step=>{window.__step=step};
const until=async(fn,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(15)}return false};
const ICON='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const calls=[];
const listeners=new Set();
const opened=new Map();
let layout=[
	{id:'a',type:'site',title:'Alpha',url:'https://alpha.example/',icon:ICON},
	{id:'b',type:'site',title:'Beta',url:'https://beta.example/'},
	{id:'c',type:'site',title:'Gamma',url:'https://gamma.example/'},
];
window.myHarnessDesktop={
	browser:async command=>{
		calls.push(JSON.parse(JSON.stringify(command)));
		if(command.action==='speeddial')return {items:layout};
		if(command.action==='speeddial-save'){layout=command.items;return {items:layout};}
		if(command.action==='bookmarks')return {bookmarks:[{id:'bm',title:'Docs',url:'https://docs.example/'}]};
		if(command.action==='state')return {tabId:command.tabId,url:opened.get(command.tabId)||'',title:'',loading:false,error:'',canGoBack:false,canGoForward:false};
		if(command.action==='ensure'){if(command.url)opened.set(command.tabId,command.url);return {tabId:command.tabId,url:command.url,loading:false};}
		if(command.action==='permissions')return {permissions:[],pending:[]};
		return {ok:true};
	},
	external:async()=>{},
	onStatus:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
	onWorkspace:()=>()=>{},replyWorkspace:async()=>({ok:true}),
};
const emit=value=>{for(const listener of [...listeners])listener(value)};
const saves=()=>calls.filter(c=>c.action==='speeddial-save');
const tiles=()=>[...document.querySelectorAll('.sd > .sd-grid > .sd-tile')];
const label=tile=>tile.querySelector('.sd-label')?.textContent;
// A real drag spreads its events over many frames; each step waits a little so the page renders in between.
const drag=async(from,to,zone)=>{
	const data=new DataTransfer();
	const box=to.getBoundingClientRect();
	const clientX=zone==='into'?box.left+box.width/2:box.left+2;
	from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));
	await wait(30);
	to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data,clientX,clientY:box.top+20}));
	await wait(30);
	to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX,clientY:box.top+20}));
	from.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));
};
try {
	mark('grid');
	const mount=document.getElementById('app');
	// The group motion is checked below; "system" would follow the runner (GitHub's Windows images report reduced motion).
	setView({motion:'on',panelOpen:true,wsTabs:[{id:'browser:new',type:'browser',url:''}],wsActive:'browser:new'});
	render(h(BrowserPanel,{tabId:'browser:new',url:''}),mount);
	check(await until(()=>tiles().length===4),'the empty tab did not show 3 shortcuts and the add tile: '+tiles().length);
	check(tiles().map(label).join(',')==='Alpha,Beta,Gamma,Add shortcut','wrong tiles: '+tiles().map(label).join(','));
	check(!!tiles()[0].querySelector('img.sd-favicon')&&!!tiles()[1].querySelector('.sd-letter'),'icons or letters are missing');
	const grid=document.querySelector('.sd').getBoundingClientRect();
	const target=document.querySelector('.desktop-browser-target').getBoundingClientRect();
	check(Math.abs((grid.left+grid.right)/2-(target.left+target.right)/2)<4,'the grid is not centred');

	mark('group');
	await drag(tiles()[2],tiles()[0],'into');
	check(await until(()=>saves().length===1),'dropping on the middle did not save');
	const grouped=saves()[0].items;
	check(grouped.length===2&&grouped[0].type==='group'&&grouped[0].items.map(s=>s.id).join()==='a,c','not grouped: '+JSON.stringify(grouped));
	check(await until(()=>!!document.querySelector('.sd-icon.group')),'the group tile is not drawn');
	check(document.querySelectorAll('.sd-icon.group > *').length===2,'the group tile does not show its two icons');

	mark('reorder');
	await drag(tiles()[1],tiles()[0],'before');
	check(await until(()=>saves().length===2),'dropping on an edge did not save');
	check(saves()[1].items.map(i=>i.id)[0]==='b','the edge drop did not move Beta first: '+JSON.stringify(saves()[1].items.map(i=>i.id)));

	mark('open-group');
	const groupTile=tiles().find(tile=>tile.querySelector('.sd-icon.group'));
	groupTile.querySelector('.sd-button').click();
	check(await until(()=>!!document.querySelector('.sd-group')),'the group did not open');
	check(document.querySelector('.sd-group').getAnimations().length>0,'the group does not grow out of its tile');
	const title=document.querySelector('.sd-group-title');
	title.value='Work';
	title.dispatchEvent(new Event('change',{bubbles:true}));
	check(await until(()=>saves().length===3&&saves()[2].items.some(i=>i.type==='group'&&i.title==='Work')),'renaming the group did not save');
	document.querySelector('.sd-group-backdrop').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
	check(!!document.querySelector('.sd-group')&&document.querySelector('.sd-group').getAnimations().length>0,'the group vanished instead of folding back into its tile');
	check(await until(()=>!document.querySelector('.sd-group')),'clicking outside did not close the group');

	mark('delete');
	const beta=tiles().find(tile=>label(tile)==='Beta');
	beta.querySelector('.sd-button').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:50,clientY:50}));
	check(await until(()=>!!document.querySelector('.sd-menu')),'right-click did not open the menu');
	[...document.querySelectorAll('.sd-menu button')].find(b=>b.textContent==='Delete').click();
	check(await until(()=>saves().length===4&&!saves()[3].items.some(i=>i.id==='b')),'delete did not save');

	mark('add');
	tiles().at(-1).querySelector('.sd-button').click();
	check(await until(()=>!!document.querySelector('.sd-editor')),'the add tile did not open the editor');
	check([...document.querySelectorAll('.sd-choice')].some(b=>b.textContent.includes('Docs')),'bookmarks are not offered');
	const fields=document.querySelectorAll('.sd-editor input');
	fields[1].value='example.org';
	fields[1].dispatchEvent(new Event('input',{bubbles:true}));
	await wait(30);
	document.querySelector('.sd-editor button[type=submit]').click();
	check(await until(()=>saves().length===5&&saves()[4].items.some(i=>i.url==='https://example.org/'&&i.title==='')),'the typed shortcut without a name was not saved icon-only: '+JSON.stringify(saves().at(-1)));

	mark('open-site');
	const alphaLess=tiles().find(tile=>tile.querySelector('.sd-button')?.getAttribute('aria-label')==='example.org');
	check(alphaLess&&label(alphaLess)==='','a shortcut without a name should show its icon alone, named by its host for assistive technology');
	alphaLess.querySelector('.sd-button').click();
	check(await until(()=>calls.some(c=>c.action==='ensure'&&c.url==='https://example.org/')),'clicking a shortcut did not open it in this tab');

	mark('host-broadcast');
	// Another tab changed the layout: the host broadcasts it, an open panel follows, a new panel reads it.
	// Opening a shortcut gave this tab a page (the grid is gone); a new empty tab shows the grid again.
	check(await until(()=>!document.querySelector('.sd')),'the grid stayed over the opened page');
	render(null,mount);
	setView({wsTabs:[{id:'browser:new2',type:'browser',url:''}],wsActive:'browser:new2'});
	render(h(BrowserPanel,{tabId:'browser:new2',url:''}),mount);
	check(await until(()=>tiles().length>1),'a new empty tab did not show the grid');
	layout=[{id:'z',type:'site',title:'Zed',url:'https://zed.example/'}];
	emit({type:'speeddial',items:layout});
	check(await until(()=>tiles().length===2&&label(tiles()[0])==='Zed'),'an open panel did not follow the broadcast layout');
	render(null,mount);
	render(h(BrowserPanel,{tabId:'browser:new2',url:''}),mount);
	check(await until(()=>tiles().length===2&&label(tiles()[0])==='Zed'),'a fresh panel did not read the saved layout');
	render(null,mount);

	mark('icon-only');
	const strip=document.createElement('div');
	document.body.appendChild(strip);
	let toggled=0;
	const tabs=[{id:'changes',type:'changes'},{id:'browser:x',type:'browser',url:'https://x.example/page',title:'X Page'}];
	const drawStrip=(iconsOnly,icons)=>render(h(WorkspaceTabs,{tabs,activeId:'changes',iconsOnly,icons,onToggleIconsOnly:()=>{toggled++},onActivate(){},onClose(){},onCloseOthers(){},onMove(){}}),strip);
	drawStrip(false,{});
	const webTab=()=>strip.querySelector('[data-tab-id="browser:x"] .ws-tab');
	check(await until(()=>!!webTab()),'the website tab is not drawn');
	check(getComputedStyle(webTab().querySelector('.ws-tab-label')).display!=='none','the name is hidden without the preference');
	drawStrip(true,{'https://x.example':ICON});
	await wait(30);
	check(webTab().classList.contains('icon-only'),'icon-only class missing');
	check(getComputedStyle(webTab().querySelector('.ws-tab-label')).display==='none','the name is still shown');
	check(!!webTab().querySelector('img.ws-tab-favicon'),'the site icon is not shown');
	check(webTab().getAttribute('aria-label')==='X Page','the icon-only tab lost its accessible name');
	check(webTab().getBoundingClientRect().width<44,'the icon-only tab is not compact: '+webTab().getBoundingClientRect().width);
	const panelTab=strip.querySelector('[data-tab-id="changes"] .ws-tab');
	check(getComputedStyle(panelTab.querySelector('.ws-tab-label')).display!=='none','a panel tab lost its name');
	webTab().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}));
	check(await until(()=>[...strip.querySelectorAll('.ws-menu button')].some(b=>b.textContent==='Show website tab names')),'the tab menu does not offer the toggle');
	[...strip.querySelectorAll('.ws-menu button')].find(b=>b.textContent==='Show website tab names').click();
	check(toggled===1,'the toggle did not run');
	render(null,strip);

	mark('background-icon');
	setView({wsTabs:[{id:'browser:bg',type:'browser',url:'https://bg.example/a'},{id:'changes',type:'changes'}],wsActive:'changes',browserIcons:{}});
	installWorkspaceHost();
	emit({type:'icon',tabId:'browser:bg',icon:ICON,url:'https://bg.example/a'});
	emit({type:'state',tabId:'browser:bg',state:{url:'https://bg.example/b',title:'Background'}});
	check(state.view.browserIcons['https://bg.example']===ICON,'the background tab icon did not reach the store');
	const bg=state.view.wsTabs.find(t=>t.id==='browser:bg');
	check(bg.title==='Background'&&bg.url==='https://bg.example/b','the background tab title/url did not update: '+JSON.stringify(bg));
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
				label: "Speed dial",
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
