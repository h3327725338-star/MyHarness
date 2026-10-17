import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"shows the saved key instead of an empty field and calls the provider ready without a reload",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-stored-key-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((candidate) => candidate.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			// What the server answers once the key of a models.json provider is stored: configured, and its key named.
			server.route("GET", "/api/providers", () => ({
				providers: [
					{
						id: "plus",
						name: "plus",
						enabled: true,
						missingBaseUrl: false,
						configured: true,
						authSource: "stored",
						baseUrl: "https://api.sudocode.chat/v1",
						modelCount: 1,
						supportsApiKeyLogin: true,
						supportsOAuth: false,
						custom: true,
						credentials: {
							active: { type: "api_key", keyId: "key-default" },
							apiKeys: [{ id: "key-default", label: "Default key", suffix: "lder", active: true }],
							hasOAuth: false,
							runtimeOverride: false,
						},
					},
				],
				modelsPath: null,
				error: null,
			}));
			server.route("GET", "/api/providers/custom", () => ({
				path: null,
				apiTypes: ["openai-completions"],
				connectionDefaults: {},
				providers: [
					{
						id: "plus",
						config: {
							name: "plus",
							baseUrl: "https://api.sudocode.chat/v1",
							api: "openai-completions",
							authMode: "apiKey",
							models: [{ id: "gpt-5.6-luna", input: ["text"], contextWindow: 256000, maxTokens: 128000 }],
						},
					},
				],
				hiddenPlaceholder: "••••••",
			}));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {ProvidersPage} from '/js/providers-page.js';
import {useStore} from '/js/store.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await wait(40)}throw Error('timed out waiting for the UI')};
try {
 setLang('en');
 render(h(ProvidersPage,{}),document.getElementById('app'));
 await until(()=>[...document.querySelectorAll('.prov-item')].some(el=>el.textContent.includes('plus')));
 [...document.querySelectorAll('.prov-item')].find(el=>el.textContent.includes('plus')).click();
 await until(()=>document.querySelector('.key-current'));
 const badge=[...document.querySelectorAll('.prov-head .badge')].map(el=>el.textContent.trim());
 check(badge.includes('Ready'),'the provider is not reported ready: '+badge.join('|'));
 check(!badge.includes('No API key'),'the missing-API-key warning is still shown');
 const current=document.querySelector('.key-current').textContent;
 check(current.includes('Default key'),'the stored key is not named: '+current);
 check(current.includes('\\u2022\\u2022\\u2022\\u2022lder'),'the stored key suffix is not masked: '+current);
 check(!document.querySelector('.pf-fields input[type=password]'),'the key is still asked for in an empty field');
 const toggle=document.querySelector('.prov-head button.toggle');
 check(toggle,'the enable switch is missing');
 check(toggle.disabled!==true,'the enable switch is unavailable');
 check(toggle.getAttribute('aria-checked')==='true','the provider is not switched on');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Provider saved key render test",
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
