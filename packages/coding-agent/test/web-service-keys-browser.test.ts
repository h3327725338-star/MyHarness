import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * Getting a key for a ready-made service, in real Chromium with a recording desktop host and a stub server:
 *
 * - Settings → Providers opens on the built-in Nebius card when no provider exists; "Get an API key" closes Settings and
 *   opens the Token Factory key page in a website tab, and a strip above that page takes the key;
 * - the strip saves through the same setup the card uses and then offers the way back to Settings;
 * - the card's own key field sets Nebius up too, after which the card shows the console links and the spend estimate;
 * - the Tavily strip saves into the web search keys; a tab opened for another reason has no strip.
 */
it.skipIf(!installed.length)(
	"service key pages and the paste strip",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-service-keys-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
			// Runs in the plain unit suite too: headless, never a window pulled to the front.
			unattended: true,
		});
		const posts: Array<{ path: string; body: any }> = [];
		let nebiusReady = false;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/web-prefs", () => ({ prefs: null }));
			server.route("PUT", "/api/web-prefs", () => ({ ok: true }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/api/settings", () => ({ items: [], tavilyApiKey: { configured: false, keys: [] } }));
			server.route("GET", "/api/providers", () => ({
				providers: nebiusReady
					? [
							{
								id: "nebius",
								name: "Nebius Token Factory",
								baseUrl: "https://api.tokenfactory.nebius.com/v1/",
								enabled: true,
								configured: true,
								custom: true,
								modelCount: 4,
								supportsApiKeyLogin: true,
								credentials: {
									active: null,
									apiKeys: [{ id: "k1", label: "Token Factory", suffix: "abcd", active: true }],
									hasOAuth: false,
								},
							},
						]
					: [],
				modelsPath: "C:/agent/models.json",
			}));
			server.route("GET", "/api/providers/custom", () => ({
				providers: nebiusReady
					? [
							{
								id: "nebius",
								config: {
									name: "Nebius Token Factory",
									baseUrl: "https://api.tokenfactory.nebius.com/v1/",
									api: "openai-completions",
									models: [{ id: "nvidia/Nemotron-3-Ultra-550b-a55b" }],
								},
							},
						]
					: [],
				apiTypes: ["openai-completions"],
				connectionDefaults: {
					keepAliveSeconds: 30,
					keepAliveMin: 1,
					keepAliveMax: 600,
					ipFamily: "auto",
					ipFamilies: ["auto"],
				},
			}));
			server.route("GET", "/api/providers/nebius", () => ({
				id: "nebius",
				configured: nebiusReady,
				hasKey: nebiusReady,
				apiKeysUrl: "https://tokenfactory.nebius.com/project/api-keys",
				consoleUrl: "https://tokenfactory.nebius.com/",
				spend: nebiusReady
					? { total: 0.0123, currency: "USD", requests: 7, since: "2026-10-29T08:00:00.000Z" }
					: null,
			}));
			server.route("POST", "/api/providers/nebius/setup", ({ body }) => {
				posts.push({ path: "nebius", body });
				if ((body as any)?.apiKey === "nb-wrong")
					return {
						ok: false,
						code: "rejected_key",
						message: "Nebius Token Factory refused this API key (HTTP 401). Check that it was copied whole.",
					};
				nebiusReady = true;
				return {
					ok: true,
					models: [
						{ slot: "ultra", id: "nvidia/Nemotron-3-Ultra-550b-a55b", name: "Nemotron 3 Ultra" },
						{ slot: "lightning", id: "nvidia/Nemotron-3_5-Lightning", name: "Nemotron 3.5 Lightning" },
					],
					missing: ["nano", "vision"],
					assigned: ["main", "compactionModel", "subAgent"],
					kept: [],
					turnedOn: ["subAgent"],
					listError: null,
				};
			});
			server.route("POST", "/api/settings/tavily-key/add", ({ body }) => {
				posts.push({ path: "tavily", body });
				return { ok: true };
			});
			server.route("GET", "/api/test-posts", () => posts);
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><div id="settings"></div><div id="app" style="position:fixed;left:0;right:0;bottom:0;height:420px;display:flex;flex-direction:column"></div><script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message))});setTimeout(function(){if(!document.getElementById("ready"))document.body.insertAdjacentHTML("beforeend","<p id=\\"ready\\">FAILED module did not finish; step="+(window.__step||"import")+" errors="+window.__errors.join(" / ")+"</p>")},40000)</script><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
window.__errors=window.__errors||[];
window.addEventListener('error',event=>window.__errors.push(String(event.message)));
import {h,render} from '/vendor/preact.js';
import {BrowserPanel} from '/js/panel-browser.js';
import {ProvidersPage} from '/js/providers-page.js';
import {openServicePage} from '/js/service-keys.js';
import {setView,state,loadProviders} from '/js/store.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const mark=step=>{window.__step=step};
const until=async(fn,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await wait(20)}return false};
const calls=[];
window.myHarnessDesktop={
	browser:async command=>{
		calls.push(JSON.parse(JSON.stringify(command)));
		if(command.action==='downloads')return {folder:'',downloads:[]};
		if(command.action==='bookmarks')return {bookmarks:[]};
		if(command.action==='speeddial')return {items:[]};
		if(command.action==='state')return {tabId:command.tabId,url:'https://example.test/',title:'Site',loading:false,error:'',canGoBack:false,canGoForward:false};
		if(command.action==='ensure')return {tabId:command.tabId,url:command.url,loading:false};
		if(command.action==='permissions')return {permissions:[],pending:[]};
		return {ok:true};
	},
	openPath:async()=>null,revealPath:async()=>({ok:true}),
	external:async url=>{calls.push({action:'external',url})},
	onStatus:()=>()=>{},onWorkspace:()=>()=>{},replyWorkspace:async()=>({ok:true}),
};
const strip=()=>document.querySelector('.ws-key-strip');
const showTab=id=>render(h(BrowserPanel,{key:id,tabId:id,url:state.view.wsTabs.find(tab=>tab.id===id)?.url||''}),document.getElementById('app'));
try {
	mark('providers');
	setView({settingsOpen:true,settingsSection:'providers',providerSel:null,panelOpen:false,wsTabs:[],wsActive:null});
	await loadProviders();
	render(h(ProvidersPage,{}),document.getElementById('settings'));
	check(await until(()=>!!document.querySelector('.prov-builtin.on')),'an empty provider list does not open on Nebius');
	check(await until(()=>document.querySelector('.prov-title')?.textContent.includes('Nebius Token Factory')),'the Nebius setup card is not shown');
	check(document.querySelector('.prov-detail input').spellcheck===false,'the key field spell-checks the key');
	check(document.querySelectorAll('.nebius-plan-row').length===4,'the job plan does not list the four models');

	mark('get-key');
	[...document.querySelectorAll('.prov-detail .btn')].find(b=>b.textContent.includes('Get an API key')).click();
	check(state.view.settingsOpen===false,'Settings stays open over the page');
	const nebiusTab=state.view.wsActive;
	check(state.view.wsTabs.find(tab=>tab.id===nebiusTab)?.url==='https://tokenfactory.nebius.com/project/api-keys','the key page did not open in a website tab: '+JSON.stringify(state.view.wsTabs));
	check(!calls.some(c=>c.action==='external'),'the key page went to the system browser');
	showTab(nebiusTab);
	check(await until(()=>!!strip()),'there is no paste strip above the key page');
	check(strip().textContent.includes('Nebius Token Factory'),'the strip does not name the service');

	mark('strip-wrong');
	const input=()=>strip().querySelector('input');
	const type=(field,text)=>{field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}))};
	type(input(),'nb-wrong');
	await wait(30);
	strip().querySelector('button[type=submit]').click();
	check(await until(()=>!!strip().querySelector('.ws-key-error')),'a refused key shows no error');
	check(strip().querySelector('.ws-key-error').textContent.includes('HTTP 401'),'the error does not say why');

	mark('strip-save');
	type(input(),'nb-good');
	await wait(30);
	strip().querySelector('button[type=submit]').click();
	check(await until(()=>strip()?.classList.contains('ok')),'the strip does not say the key was saved');
	check(strip().textContent.includes('Nemotron 3 Ultra'),'the strip does not name the models: '+strip().textContent);
	const sent=()=>fetch('/api/test-posts').then(r=>r.json());
	check((await sent()).at(-1).body.apiKey==='nb-good','the strip did not send the key to the setup');
	[...strip().querySelectorAll('.btn')].find(b=>b.textContent.includes('Back to Settings')).click();
	check(state.view.settingsOpen===true&&state.view.settingsSection==='providers'&&state.view.providerSel==='nebius','Back to Settings does not open the Nebius card');

	mark('configured-card');
	render(null,document.getElementById('settings'));
	render(h(ProvidersPage,{}),document.getElementById('settings'));
	check(await until(()=>!!document.querySelector('.nebius-card')),'the configured Nebius has no balance card');
	check(await until(()=>document.querySelector('.nebius-spend').textContent.includes('$0.0123')),'the spend estimate is not shown: '+document.querySelector('.nebius-spend')?.textContent);
	const consoleButton=[...document.querySelectorAll('.nebius-links .btn')].find(b=>b.textContent.includes('Balance and top up'));
	consoleButton.click();
	const consoleTab=state.view.wsActive;
	check(state.view.wsTabs.find(tab=>tab.id===consoleTab)?.url==='https://tokenfactory.nebius.com/','the console did not open');
	showTab(consoleTab);
	await wait(150);
	check(!strip(),'the console tab shows a key strip');

	mark('tavily');
	openServicePage('tavily');
	const tavilyTab=state.view.wsActive;
	check(state.view.wsTabs.find(tab=>tab.id===tavilyTab)?.url==='https://app.tavily.com/','the Tavily key page did not open');
	showTab(tavilyTab);
	check(await until(()=>strip()?.textContent.includes('Tavily')),'there is no Tavily strip');
	type(input(),'tvly-test');
	await wait(30);
	strip().querySelector('button[type=submit]').click();
	check(await until(()=>strip()?.classList.contains('ok')),'the Tavily key was not saved');
	check((await sent()).some(p=>p.path==='tavily'&&p.body.key==='tvly-test'),'the Tavily key went elsewhere');
	strip().querySelector('[aria-label="Close"]').click();
	check(await until(()=>!strip()),'the strip does not close');
	check(window.__errors.length===0,'page errors: '+window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">FAILED '+(window.__step||'')+': '+String(error.stack).replace(/</g,'(')+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Service keys",
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
