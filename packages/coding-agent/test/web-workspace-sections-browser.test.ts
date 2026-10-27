import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The sections of the workspace panel in a real browser: the navigation row reaches Changes, Files, Terminal, Session
 * and (after a divider) the browser in one click; the tabs of the browser and of Files sit in the same row, Files and
 * the browser come back on their last tab, closing stays in the section while it has tabs, and the file list leads
 * the Files tabs. This runs the shipped page modules
 * unchanged; only the API routes are stubs.
 */
it.skipIf(!installed.length)(
	"reaches every panel section from one row and keeps each section's own tabs",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-workspace-sections-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
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
import {PanelNav,WorkspaceTabs} from '/js/workspace-tabs.js';
import {workspaceTabSection,recentSectionTabs} from '/js/workspace-model.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const ids=()=>JSON.stringify(state.view.wsTabs.map(t=>t.id));
try {
	check(workspaceTabSection({type:'browser',url:''})==='browser'&&workspaceTabSection({type:'file',path:'a'})==='files'&&workspaceTabSection({type:'files'})==='files'&&workspaceTabSection({type:'terminal'})==='terminal','tabs are put in the wrong section');
	const listed=[{id:'files',type:'files'},{id:'file:a',type:'file',path:'a'},{id:'changes',type:'changes'}];
	check(JSON.stringify(recentSectionTabs(['files','changes','gone'],listed,'file:a'))==='["file:a","changes"]','the recent list keeps one tab per section, newest first');
	const closedViews=[];
	window.myHarnessDesktop={browser:async(command)=>{if(command.action==='close')closedViews.push(command.tabId);return {}}};
	setView({panelOpen:true,wsTabs:[],wsActive:null,wsClosed:[]});
	actions.openWorkspace({type:'changes'});
	actions.openWorkspace({type:'file',path:'one.ts'});
	const site=actions.openWorkspace({type:'browser',url:'https://example.com/'});
	const site2=actions.openWorkspace({type:'browser',url:'https://example.org/'});

	// Every section is one click from the navigation row; Files and the browser come back on the tab they showed last.
	actions.activateWorkspaceTab(site);
	actions.showWorkspaceSection('terminal');
	check(state.view.wsActive==='terminal','the terminal section did not open: '+state.view.wsActive);
	actions.showWorkspaceSection('files');
	check(state.view.wsActive==='file:one.ts','Files did not come back on its last file: '+state.view.wsActive);
	actions.showWorkspaceSection('context');
	check(state.view.wsActive==='context','the session section did not open');
	actions.showWorkspaceSection('browser');
	check(state.view.wsActive===site,'the browser did not come back on its last website tab: '+state.view.wsActive);
	actions.openWorkspace({type:'files'});
	actions.showWorkspaceSection('changes');
	actions.showWorkspaceSection('files');
	check(state.view.wsActive==='files','Files forgot that the file list was on screen: '+state.view.wsActive);
	actions.activateWorkspaceTab('changes');
	actions.openBrowser();
	check(state.view.wsActive===site,'the header browser button did not return to the last website tab: '+state.view.wsActive);

	// Closing a website tab shows the next website tab; closing the last one returns to the section shown before.
	actions.closeWorkspaceTab(site);
	check(state.view.wsActive===site2,'closing a website tab left the browser: '+state.view.wsActive);
	actions.showWorkspaceSection('terminal');
	actions.showWorkspaceSection('browser');
	actions.closeWorkspaceTab(site2);
	check(state.view.wsActive==='terminal','closing the last website tab did not return to the section before: '+state.view.wsActive);

	// The strip's "close other tabs" closes only the tabs of its own section.
	const a=actions.openWorkspace({type:'browser',url:'https://a.example/'});
	const b=actions.openWorkspace({type:'browser',url:'https://b.example/'});
	actions.closeOtherWorkspaceTabs(b,{sameSection:true});
	check(!state.view.wsTabs.some(t=>t.id===a)&&state.view.wsTabs.some(t=>t.id===b),'the other website tab was not closed: '+ids());
	check(['changes','file:one.ts','terminal','files'].every(id=>state.view.wsTabs.some(t=>t.id===id)),'closing other website tabs closed other sections: '+ids());
	check(closedViews.includes(a)&&!closedViews.includes(b),'the native views closed were wrong: '+JSON.stringify(closedViews));

	// The navigation row marks the section on screen and puts the browser after a divider.
	const host=document.createElement('div');
	document.getElementById('app').append(host);
	const shown=[];
	render(h(PanelNav,{section:'files',browser:true,onShow:value=>shown.push(value)}),host);
	await wait(30);
	const buttons=[...host.querySelectorAll('.ws-nav-btn')];
	check(buttons.length===5,'the navigation row has '+buttons.length+' buttons');
	check(buttons[1].classList.contains('active')&&buttons[1].getAttribute('aria-selected')==='true','Files is not marked as on screen');
	check(buttons[4].previousElementSibling?.classList.contains('ws-nav-sep'),'the browser is not set apart by a divider');
	buttons[4].click();
	check(shown[0]==='browser','clicking the browser did not ask for it');
	render(h(PanelNav,{section:'changes',browser:false,onShow:()=>{}}),host);
	await wait(30);
	check(host.querySelectorAll('.ws-nav-btn').length===4&&!host.querySelector('.ws-nav-sep'),'the browser entry shows without a browser');
	// The tabs of the section sit in the same row: in the browser they take the browser entry's place after the divider,
	// in Files they follow the browser entry; the section names fold to icons to make room.
	render(h(PanelNav,{section:'browser',browser:true,onShow:()=>{}},h('span',{class:'probe-strip'})),host);
	await wait(30);
	check(host.querySelector('.ws-nav.compact')&&host.querySelectorAll('.ws-nav-btn').length===4&&host.querySelector('.ws-nav-sep + .ws-nav-strip .probe-strip'),'the browser tabs are not in the row in place of the browser entry');
	render(h(PanelNav,{section:'files',browser:true,onShow:()=>{}},h('span',{class:'probe-strip'})),host);
	await wait(30);
	check(host.querySelectorAll('.ws-nav-btn').length===5&&host.querySelectorAll('.ws-nav-sep').length===2&&host.querySelector('.ws-nav-strip .probe-strip'),'the file tabs are not after the browser entry');
	render(h(PanelNav,{section:'terminal',browser:true,onShow:()=>{}}),host);
	await wait(30);
	check(!host.querySelector('.ws-nav.compact'),'the section names stay folded without tabs');

	// The file list leads the Files row under its own name and cannot be closed from there.
	render(h(WorkspaceTabs,{tabs:[{id:'files',type:'files'},{id:'file:one.ts',type:'file',path:'one.ts'}],activeId:'files',titleFor:t=>t.type==='files'?'File list':null,closable:t=>t.type!=='files',onActivate:()=>{},onClose:()=>{},onCloseOthers:()=>{},onMove:()=>{}}),host);
	await wait(30);
	const strip=[...host.querySelectorAll('.ws-tab')];
	check(strip[0].textContent.includes('File list')&&!strip[0].querySelector('.ws-tab-close'),'the file list tab is misnamed or closable');
	check(strip[1].querySelector('.ws-tab-close'),'a file tab lost its close button');
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Workspace sections",
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
