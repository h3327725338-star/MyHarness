import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * A website tab that plays sound marks its chat in the sidebar, also when that chat is not on screen: the desktop host's
 * state events reach the store for every tab (workspace-host.js), store.js maps the tab to the chat whose panel holds
 * it, and the row shows a speaker (grey when only muted tabs play). The mark goes when the sound stops or the tab closes.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"marks the chats whose website tabs play sound, also chats that are not on screen",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-sidebar-playing-"));
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
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><div id="app" style="width:340px"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Sidebar} from '/js/sidebar.js';
import {installWorkspaceHost} from '/js/workspace-host.js';
import {saveStoredPanel,set,setView,GENERAL_KEY} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(15)}return false};
let emit=null;
window.myHarnessDesktop={onStatus:cb=>{emit=cb;return()=>{}},onWorkspace:()=>()=>{},replyWorkspace:async()=>{},browser:async()=>({})};
try {
	installWorkspaceHost();
	if(!emit) throw Error('the workspace host did not listen to the desktop status');
	setView({lang:'en',motion:'off',chatMode:'coding',expanded:{[GENERAL_KEY]:true}});
	// Two chats; B has a website tab in its saved panel (it is not on screen).
	saveStoredPanel('chat-b',{panelOpen:true,wsTabs:[{id:'browser:b1',type:'browser',url:'https://video.example/'}],wsActive:'browser:b1',wsRecent:[],wsClosed:[]});
	const now=Date.now();
	set({workspaces:{list:[],sessions:{},unbound:[{id:'chat-a',path:'C:/test/a.jsonl',name:'Chat A',messageCount:2,modified:now-60000},{id:'chat-b',path:'C:/test/b.jsonl',name:'Chat B',messageCount:2,modified:now-120000}],archived:[],errors:{},loaded:true},slots:[]});
	render(h(Sidebar,{}),document.getElementById('app'));
	const row=name=>[...document.querySelectorAll('.chat-row')].find(r=>r.textContent.includes(name));
	if(!(await until(()=>row('Chat A')&&row('Chat B')))) throw Error('the chats are not listed');
	if(document.querySelector('.chat-sound')) throw Error('a speaker is shown before anything plays');
	emit({tabId:'browser:b1',type:'state',state:{audible:true,muted:false}});
	if(!(await until(()=>row('Chat B')?.querySelector('.chat-sound:not(.muted)')))) throw Error('the chat playing in the background has no speaker');
	if(row('Chat A').querySelector('.chat-sound')) throw Error('a quiet chat got a speaker');
	emit({tabId:'browser:b1',type:'state',state:{audible:true,muted:true}});
	if(!(await until(()=>row('Chat B')?.querySelector('.chat-sound.muted')))) throw Error('a muted tab that plays is not shown as muted');
	emit({tabId:'browser:b1',type:'state',state:{audible:false,muted:true}});
	if(!(await until(()=>!row('Chat B')?.querySelector('.chat-sound')))) throw Error('the speaker stayed after the sound stopped');
	emit({tabId:'browser:b1',type:'state',state:{audible:true,muted:false}});
	if(!(await until(()=>row('Chat B')?.querySelector('.chat-sound')))) throw Error('the speaker did not come back');
	emit({tabId:'browser:b1',type:'closed'});
	if(!(await until(()=>!row('Chat B')?.querySelector('.chat-sound')))) throw Error('the speaker stayed after the tab closed');
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Sidebar playing mark test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			const verdict = /id="ready">([^<]*)</.exec(page.text)?.[1] ?? "no ready marker";
			expect(verdict).toBe("passed");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	60000,
);
