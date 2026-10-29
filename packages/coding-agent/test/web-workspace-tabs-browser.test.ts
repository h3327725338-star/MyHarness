import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The workspace in a real browser: several tabs stay open at once, the strip switches/closes/restores them, and the
 * same commands the Agent's workspace tool sends through the desktop host reach the page and report the state they
 * reached. This runs the shipped page modules unchanged; only the server's API routes are stubs.
 */
it.skipIf(!installed.length)(
	"keeps several workspace tabs open, switches, closes and restores them, and answers host commands",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-workspace-tabs-"));
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
			server.route("GET", "/api/files/list", () => ({ entries: [] }));
			server.route("GET", "/api/files/read", () => ({ kind: "text", content: "", size: 0 }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {setView,state} from '/js/store.js';
import {actions} from '/js/actions.js';
import {WorkspaceTabs} from '/js/workspace-tabs.js';
import {normalizeWorkspaceTabs,workspaceTabTitle} from '/js/workspace-model.js';
import {installWorkspaceHost,runWorkspaceCommand} from '/js/workspace-host.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const until=async(fn)=>{for(let i=0;i<120;i++){if(fn())return;await wait(50)}throw new Error('timed out waiting for the workspace UI')};
try {
	const normalized=normalizeWorkspaceTabs([{type:'file',path:'a.ts'},{type:'file',path:'a.ts'},{type:'browser',url:'https://example.com'},{type:'bogus'}]);
	check(normalized.length===2,'duplicate or invalid tabs were kept: '+JSON.stringify(normalized));
	check(workspaceTabTitle({type:'browser',url:'https://www.example.com/x'})==='example.com','browser tab title is the site host');
	check(workspaceTabTitle({type:'file',path:'dir/x.ts'})==='x.ts','file tab title is the file name');
	check(normalizeWorkspaceTabs([]).length===1,'an empty list must fall back to one panel tab');

	setView({panelOpen:true,wsTabs:normalizeWorkspaceTabs(null,'changes'),wsActive:'changes',wsClosed:[]});
	actions.openWorkspace({type:'file',path:'one.ts'});
	actions.openWorkspace({type:'file',path:'two.ts'});
	check(state.view.wsTabs.length===3,'opening a second file replaced the first: '+JSON.stringify(state.view.wsTabs.map(t=>t.id)));
	check(state.view.wsActive==='file:two.ts','the new tab did not become active');
	actions.activateWorkspaceTab('file:one.ts');
	check(state.view.wsActive==='file:one.ts','activating a tab failed');
	check(state.view.wsTabs.some(t=>t.id==='file:two.ts'),'the other tab disappeared on activation');

	const host=document.createElement('div');
	document.getElementById('app').append(host);
	const strip=()=>render(h(WorkspaceTabs,{tabs:state.view.wsTabs,activeId:state.view.wsActive,onActivate:id=>actions.activateWorkspaceTab(id),onClose:id=>actions.closeWorkspaceTab(id),onCloseOthers:id=>actions.closeOtherWorkspaceTabs(id),onMove:(a,b)=>actions.moveWorkspaceTab(a,b)}),host);
	strip(); await wait(60);
	check(document.querySelectorAll('.ws-tab').length===3,'the strip did not render three tabs');
	check((document.querySelector('.ws-tab.active')||{}).textContent.includes('one.ts'),'the active tab is not marked');
	const overflow=getComputedStyle(document.querySelector('.ws-tabs'));
	check(overflow.overflowX==='auto','the tab strip does not scroll when tabs do not fit');

	const findTab=(label)=>[...document.querySelectorAll('.ws-tab')].find(el=>el.textContent.includes(label));
	findTab('two.ts').click(); await wait(60); strip(); await wait(30);
	check(state.view.wsActive==='file:two.ts','clicking a tab did not activate it');
	findTab('two.ts').dispatchEvent(new MouseEvent('auxclick',{bubbles:true,button:1})); await wait(60); strip(); await wait(30);
	check(!state.view.wsTabs.some(t=>t.id==='file:two.ts'),'middle-click did not close the tab');
	check(state.view.wsClosed.some(t=>t.id==='file:two.ts'),'the closed tab was not remembered');

	findTab('one.ts').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:20}));
	await until(()=>document.querySelector('.ws-menu'));
	const closeOthers=[...document.querySelectorAll('.ws-menu button')].find(button=>/other/i.test(button.textContent));
	check(closeOthers,'the close-others item is missing: '+document.querySelector('.ws-menu').textContent);
	closeOthers.click(); await wait(60);
	check(state.view.wsTabs.length===1,'close others kept '+state.view.wsTabs.length+' tabs');
	actions.reopenWorkspaceTab(); await wait(60);
	check(state.view.wsTabs.some(t=>t.type==='changes')&&state.view.wsTabs.length===2,'restoring the most recently closed tab failed: '+JSON.stringify(state.view.wsTabs.map(t=>t.id)));
	check(state.view.wsClosed.every(t=>t.type!=='changes'),'the restored tab is still in the closed list');

	const tabsState=await runWorkspaceCommand({action:'tabs'});
	check(Array.isArray(tabsState.tabs)&&tabsState.tabs.length===state.view.wsTabs.length,'the tabs command reported another tab list');
	const opened=await runWorkspaceCommand({action:'open',tab:{type:'file',path:'three.ts'}});
	check(opened.tabs.some(t=>t.id==='file:three.ts')&&opened.activeId==='file:three.ts','the open command did not open and activate the tab');
	const closed=await runWorkspaceCommand({action:'close',tabId:'file:three.ts'});
	check(!closed.tabs.some(t=>t.id==='file:three.ts'),'the close command left the tab open');
	// The Agent of a chat that is not on screen (another chat, the other mode) fills its own panel, not this one.
	const onScreen=JSON.stringify(state.view.wsTabs.map(t=>t.id));
	const background=await runWorkspaceCommand({action:'open',sessionId:'background-chat',tab:{type:'file',path:'elsewhere.ts'}});
	check(JSON.stringify(state.view.wsTabs.map(t=>t.id))===onScreen,'a background chat opened a tab in the panel on screen: '+JSON.stringify(state.view.wsTabs.map(t=>t.id)));
	check(background.onScreen===false&&background.activeId==='file:elsewhere.ts'&&background.panelOpen===true,'the background chat did not get its own tab: '+JSON.stringify(background));
	const again=await runWorkspaceCommand({action:'tabs',sessionId:'background-chat'});
	check(again.tabs.length===1&&again.tabs[0].id==='file:elsewhere.ts','the background chat lost its tab: '+JSON.stringify(again));
	const backgroundClosed=await runWorkspaceCommand({action:'close',sessionId:'background-chat',tabId:'file:elsewhere.ts'});
	check(backgroundClosed.tabs.length===0&&backgroundClosed.panelOpen===false,'closing the background tab failed: '+JSON.stringify(backgroundClosed));
	let unknownFailed=false;
	try{await runWorkspaceCommand({action:'nope'})}catch(error){unknownFailed=/unknown command/.test(error.message)}
	check(unknownFailed,'an unknown command was not reported as an error');

	const pane=document.createElement('div');
	pane.className='panel-pane';
	pane.dataset.wsTab=state.view.wsActive;
	pane.innerHTML='<div class="media-view"><audio preload="metadata"></audio></div>';
	document.body.append(pane);
	const audio=pane.querySelector('audio');
	audio.volume=0.5;
	const volume=await runWorkspaceCommand({action:'media',command:'volume',value:0.25});
	check(Math.abs(audio.volume-0.25)<1e-6,'volume was not applied: '+audio.volume);
	const muted=await runWorkspaceCommand({action:'media',command:'mute'});
	check(audio.muted===true,'mute was not applied');
	await runWorkspaceCommand({action:'media',command:'pause'});
	check(audio.paused===true,'pause did not leave the media paused');
	check(volume.media.volume===0.25&&muted.media.muted===true,'the media state report is wrong');
	let badRate=false;
	try{await runWorkspaceCommand({action:'media',command:'rate',value:0})}catch(error){badRate=/rate/.test(error.message)}
	check(badRate,'an invalid playback rate was accepted');
	let noElement=false;
	try{await runWorkspaceCommand({action:'media',command:'pause',tabId:'file:missing.ts'})}catch(error){noElement=/no audio or video element/.test(error.message)}
	check(noElement,'media control without a media element did not fail: '+state.view.wsActive);

	const replies=[];
	window.myHarnessDesktop={onWorkspace:callback=>{window.__wsCallback=callback;return()=>{}},replyWorkspace:async payload=>{replies.push(payload);}};
	const off=installWorkspaceHost();
	await window.__wsCallback({requestId:'r1',command:{action:'tabs'}});
	check(replies[0]&&replies[0].requestId==='r1'&&replies[0].ok===true&&Array.isArray(replies[0].result.tabs),'the host reply for tabs is wrong: '+JSON.stringify(replies[0]));
	await window.__wsCallback({requestId:'r2',command:{action:'nope'}});
	check(replies[1]&&replies[1].ok===false&&/unknown command/.test(replies[1].error),'the host error reply is wrong');
	off();
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Workspace tabs",
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
