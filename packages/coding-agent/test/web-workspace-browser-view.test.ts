import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The native browser view is drawn above the page and cannot be clipped or stacked by it. This fixture drives the real
 * `browser-view-sync.js` and `panel-browser.js` in Chromium with a recording desktop host:
 *
 * - a visible box produces bounds with its exact rectangle, a moved box produces new bounds without a stale frame;
 * - a dialog/overlay over the box, or a clipping ancestor, hides the view (null bounds);
 * - unmounting the website tab — the action of switching to Session/Terminal/file/media — reports null bounds, so the
 *   native view cannot stay over the next tab;
 * - the workspace actions hide the native views before they switch to a non-browser tab or close the panel;
 * - the address bar, back button and every other control of the mounted tab address that same tab id.
 */
it.skipIf(!installed.length)(
	"the native browser view follows its tab box and is hidden when the tab stops being the active workspace tab",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-browser-view-sync-"));
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
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><div id="app"></div><script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message))});setTimeout(function(){if(!document.getElementById("ready"))document.body.insertAdjacentHTML("beforeend","<p id=\\"ready\\">FAILED module did not finish; step="+(window.__step||"import")+" errors="+window.__errors.join(" / ")+"</p>")},25000)</script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
window.__errors=[];
window.addEventListener('error',event=>window.__errors.push(String(event.message)));
import {h,render} from '/vendor/preact.js';
import {BrowserPanel} from '/js/panel-browser.js';
import {actions} from '/js/actions.js';
import {setView,state} from '/js/store.js';
import {browserViewRect,createBrowserViewSync} from '/js/browser-view-sync.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const mark=step=>{window.__step=step};
mark('imports');
const until=async(fn,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(15)}return false};
const calls=[];
window.myHarnessDesktop={
	browser:async command=>{
		calls.push(JSON.parse(JSON.stringify(command)));
		if(command.action==='bounds')return {ok:true,visible:!!command.rect};
		if(command.action==='state')return {tabId:command.tabId,url:'https://example.com/',title:'Example Domain',loading:false,error:'',canGoBack:true,canGoForward:false,visible:false};
		if(command.action==='find')return {ok:true,matches:3,activeMatch:1};
		if(command.action==='permissions')return {permissions:[{origin:'https://example.com',permission:'notifications',allowed:true}],pending:[]};
		if(command.action==='permission')return {ok:true,requestId:command.requestId,allowed:command.allow===true,origin:'https://example.com',permission:'notifications'};
		if(command.action==='revokePermission')return {ok:true,origin:'https://example.com',revoked:1};
		if(command.action==='denyPending')return {ok:true};
		if(command.action==='stopFind')return {ok:true};
		return {tabId:command.tabId||'browser:https://example.com/',visible:false};
	},
	external:async()=>{},onStatus:callback=>{window.__emitStatus=callback;return()=>{}},openPath:async()=>null,revealPath:async()=>null,
};
const boundsCalls=()=>calls.filter(c=>c.action==='bounds');
const lastBounds=()=>{const list=boundsCalls();return list.length?list[list.length-1]:null};
try {
	// 1. A still box gets its exact rectangle, a moved box gets the new one, and stop() reports null.
	mark('geometry');
	const panel=document.createElement('div');
	panel.id='panel';
	panel.style.cssText='position:fixed;left:100px;top:80px;width:400px;height:500px;overflow:hidden;background:#ccc';
	panel.innerHTML='<div id="target" style="width:100%;height:400px;background:#ddd"></div>';
	document.body.append(panel);
	const sync=createBrowserViewSync({host:window.myHarnessDesktop,tabId:'browser:https://example.com/',element:()=>document.getElementById('target'),onError:error=>{throw new Error(error)}});
	sync.start();
	check(await until(()=>{const last=lastBounds();return last&&last.rect&&last.rect.x===100&&last.rect.y===80&&last.rect.width===400&&last.rect.height===400}),'the visible box was not reported: '+JSON.stringify(lastBounds()));
	panel.style.left='40px';
	check(await until(()=>{const last=lastBounds();return last&&last.rect&&last.rect.x===40}),'a moved box kept the old rectangle: '+JSON.stringify(lastBounds()));
	sync.stop();
	check(await until(()=>lastBounds()&&lastBounds().rect===null),'stopping the sync must hide the native view: '+JSON.stringify(lastBounds()));

	// 2. Something of the page over the box hides it; removing the layer shows it again at the current box.
	panel.style.left='100px';
	const coveredSync=createBrowserViewSync({host:window.myHarnessDesktop,tabId:'browser:https://example.com/',element:()=>document.getElementById('target'),onError:()=>{}});
	coveredSync.start();
	check(await until(()=>lastBounds()&&lastBounds().rect),'the uncovered box was not shown');
	const layer=document.createElement('div');
	layer.className='overlay-host';
	layer.style.cssText='position:fixed;inset:0;z-index:99';
	document.body.append(layer);
	check(await until(()=>lastBounds()&&lastBounds().rect===null),'an overlay over the box did not hide the native view: '+JSON.stringify(lastBounds()));
	layer.remove();
	check(await until(()=>lastBounds()&&lastBounds().rect),'removing the overlay did not bring the native view back');
	coveredSync.stop();

	// 3. A box cut by a scrolling ancestor cannot be drawn natively: it is hidden instead of sticking out of the panel.
	const scrollHost=document.createElement('div');
	scrollHost.style.cssText='position:fixed;left:600px;top:60px;width:300px;height:200px;overflow:auto';
	scrollHost.innerHTML='<div style="height:600px"><div id="clipped" style="height:150px;width:100%;background:#eee"></div></div>';
	document.body.append(scrollHost);
	scrollHost.scrollTop=0;
	const clippedBox=document.getElementById('clipped');
	check(browserViewRect(clippedBox)!==null,'a fully visible box must be usable');
	scrollHost.scrollTop=100;
	check(browserViewRect(clippedBox)===null,'a box cut by a scrolling ancestor must not be usable');
	scrollHost.remove();

	// 4. The real tab component: it activates its tab, follows the box, and reports null bounds on unmount (the
	//    Session/Terminal/file switch). The address bar and back button belong to the same tab id.
	mark('component');
	const tabId='browser:https://example.com/';
	setView({lang:'en',motion:'off',panelOpen:true,wsTabs:[{id:tabId,type:'browser',url:'https://example.com/'},{id:'files',type:'files'}],wsActive:tabId,wsClosed:[]});
	const mount=document.createElement('div');
	mount.style.cssText='position:fixed;left:100px;top:100px;width:420px;height:520px;display:flex;flex-direction:column';
	document.body.append(mount);
	render(h(BrowserPanel,{tabId,url:'https://example.com/'}),mount);
	check(await until(()=>calls.some(c=>c.action==='ensure'&&c.tabId===tabId)),'the tab was never ensured in the host');
	check(await until(()=>calls.some(c=>c.action==='activate'&&c.tabId===tabId)),'the tab was never activated in the host');
	check(await until(()=>{const last=lastBounds();return last&&last.rect&&last.rect.width>0&&last.rect.height>0}),'the mounted tab never sent a usable rectangle: '+JSON.stringify(lastBounds()));
	const address=document.querySelector('.desktop-browser-panel input[aria-label="Address and search bar"]');
	check(address&&address.value==='https://example.com/','the address bar does not show the tab URL: '+(address&&address.value));
	const back=document.querySelector('.desktop-browser-panel button[title="Back"]');
	check(back,'the toolbar back button is missing');
	back.click();
	check(await until(()=>calls.some(c=>c.action==='back'&&c.tabId===tabId)),'the back button did not address the current browser tab: '+JSON.stringify(calls.slice(-4)));

	// 4a. The address bar is also a search box: words that are not an address go to the chosen engine, and the engine
	//     menu switches it for every tab of this browser.
	const bar=document.querySelector('.desktop-browser-panel form input');
	const form=document.querySelector('.desktop-browser-panel form');
	check(bar&&form,'the address bar is missing');
	// The back button's answer also refreshes the bar; let it land so this block only measures what it types.
	await wait(150);
	const submit=async value=>{bar.value=value;bar.dispatchEvent(new Event('input',{bubbles:true}));await wait(80);check(bar.value===value,'the typed text was dropped from the address bar: '+bar.value);bar.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))};
	await submit('deepseek pricing');
	check(await until(()=>calls.some(c=>c.action==='navigate'&&c.url==='https://www.google.com/search?q=deepseek%20pricing')),'a query was not searched with Google: '+JSON.stringify(calls.slice(-4)));
	// No magnifier in the toolbar (find in page is Ctrl+F; a magnifier beside the address field reads as "search"),
	// and the new tab button follows the star: the engine picker is a caret inside the address field.
	const labels=[...document.querySelectorAll('.ws-browser-bar > button')].map(b=>b.getAttribute('aria-label'));
	check(!labels.includes('Find in page'),'the toolbar must not carry a find-in-page magnifier: '+JSON.stringify(labels));
	check(labels.indexOf('New browser tab')===labels.indexOf('Bookmark this page')+1,'the new tab button must follow the star: '+JSON.stringify(labels));
	const engineTrigger=document.querySelector('.ws-browser-bar form button[aria-label="Search engine"]');
	check(!!engineTrigger,'the search engine picker is not inside the address bar');
	engineTrigger.click();
	check(await until(()=>!!document.querySelector('.popover .menu-item')),'the search engine menu did not open');
	// The menu is a fixed popover: it must open next to the caret, inside the window (a transformed ancestor once moved
	// it far off screen, so the caret looked dead).
	const enginePop=document.querySelector('.popover').getBoundingClientRect();
	const caret=engineTrigger.getBoundingClientRect();
	check(enginePop.right<=innerWidth&&enginePop.left>=0&&Math.abs(enginePop.top-caret.bottom)<40,'the search engine menu opened away from its caret: '+JSON.stringify({enginePop,caret}));
	const bing=[...document.querySelectorAll('.popover .menu-item')].find(item=>/Bing/.test(item.textContent));
	check(!!bing,'the search engine menu does not offer Bing');
	bing.click();
	check(await until(()=>localStorage.getItem('myharness.browserEngine')==='bing'),'the chosen search engine was not remembered');
	await submit('another query');
	check(await until(()=>calls.some(c=>c.action==='navigate'&&c.url==='https://www.bing.com/search?q=another%20query')),'the switched engine was not used: '+JSON.stringify(calls.slice(-4)));

	// 4b. Ctrl+F opens the find bar; typing runs a real find and shows the match count; closing stops it.
	window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));
	check(await until(()=>!!document.querySelector('.ws-find input')),'Ctrl+F did not open the find bar');
	const findInput=document.querySelector('.ws-find input');
	// The bar focuses its field in the next frame, so wait for the focus instead of reading it in the same tick.
	check(await until(()=>!!findInput&&document.activeElement===findInput),'the find input is not focused when the bar opens');
	findInput.value='alpha';
	findInput.dispatchEvent(new Event('input',{bubbles:true}));
	check(await until(()=>calls.some(c=>c.action==='find'&&c.text==='alpha'&&c.tabId===tabId)),'typing in the find bar did not search the page: '+JSON.stringify(calls.slice(-4)));
	check(await until(()=>/1 of 3/.test(document.querySelector('.ws-find-count')?.textContent||'')),'the match count is not shown: '+document.querySelector('.ws-find-count')?.textContent);
	const closeFind=document.querySelector('.ws-find button[title="Close find"]');
	check(!!closeFind,'the find bar close button is missing');
	closeFind.click();
	check(await until(()=>!document.querySelector('.ws-find')),'the find bar did not close');
	check(calls.some(c=>c.action==='stopFind'&&c.tabId===tabId),'closing the find bar did not stop the find');

	// 4c. A site permission request is a question in the tab, not an automatic grant; the decision is sent to the host
	//     and the permission list can revoke a session decision.
	window.__emitStatus({tabId,type:'permission-request',requestId:'p1',permission:'notifications',origin:'https://example.com'});
	check(await until(()=>!!document.querySelector('.ws-permission-ask')),'a site permission request does not show a question');
	const allowButton=[...document.querySelectorAll('.ws-permission-ask button')].find(b=>/Allow/.test(b.textContent));
	check(!!allowButton,'the permission question has no allow button');
	allowButton.click();
	check(await until(()=>calls.some(c=>c.action==='permission'&&c.requestId==='p1'&&c.allow===true)),'allowing the site permission did not reach the host');
	check(await until(()=>!document.querySelector('.ws-permission-ask')),'the permission question stayed after the answer');
	document.querySelector('.ws-browser-bar button[title="Site permissions"]').click();
	check(await until(()=>!!document.querySelector('.ws-permissions')),'the site permission list did not open');
	check(await until(()=>/notifications/.test(document.querySelector('.ws-permissions')?.textContent||'')),'the session decision is not listed');
	const revoke=[...document.querySelectorAll('.ws-permissions button')].find(b=>/Revoke/.test(b.textContent));
	check(!!revoke,'the permission list has no revoke button');
	revoke.click();
	check(await until(()=>calls.some(c=>c.action==='revokePermission'&&c.origin==='https://example.com'&&c.permissions?.includes('notifications'))),'revoking did not reach the host');
	// The list is a bubble, not a panel: a click anywhere else puts it away.
	document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
	check(await until(()=>!document.querySelector('.ws-permissions')),'clicking outside did not close the site permission list');

	// 4d. A navigation inside the tab updates the saved URL (stable tab id), so a restart restores the last page and
	//     the strip names the current host instead of the first one.
	mark('url-persist');
	window.__emitStatus({tabId,type:'state',state:{tabId,url:'https://example.com/next',title:'Next',loading:false,error:'',canGoBack:true,canGoForward:false,visible:true}});
	check(await until(()=>state.view.wsTabs.find(t=>t.id===tabId)?.url==='https://example.com/next'),'a navigation did not update the saved tab URL: '+JSON.stringify(state.view.wsTabs));

	const beforeUnmount=boundsCalls().length;
	render(null,mount);
	check(await until(()=>{const list=boundsCalls();return list.length>beforeUnmount&&list[list.length-1].tabId===tabId&&list[list.length-1].rect===null}),'unmounting the tab did not hide its native view: '+JSON.stringify(lastBounds()));

	// 5. The workspace actions hide native views before switching to a non-browser tab or closing the panel.
	const hidesBefore=calls.filter(c=>c.action==='hide').length;
	actions.activateWorkspaceTab('files');
	await wait(30);
	check(calls.filter(c=>c.action==='hide').length===hidesBefore+1,'activating a non-browser tab did not hide the native views first: '+JSON.stringify(calls.slice(-4)));
	check(state.view.wsActive==='files','the tab was not activated');
	setView({panelOpen:true,wsActive:tabId});
	const hidesBeforeClose=calls.filter(c=>c.action==='hide').length;
	actions.closePanel();
	await wait(30);
	check(calls.filter(c=>c.action==='hide').length===hidesBeforeClose+1,'closing the panel did not hide the native views');
	check(state.view.panelOpen===false,'the panel is still open');
	check(window.__errors.length===0,'page errors: '+window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">FAILED '+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Browser view sync",
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
