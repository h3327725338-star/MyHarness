import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"deletes the active API key with the replacement picked in the self-drawn Select",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-rep-select-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		let deleted: unknown = null;
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/providers", () => ({
				providers: [
					{
						id: "demo",
						name: "Demo",
						enabled: true,
						configured: true,
						baseUrl: "https://example.invalid/v1",
						modelCount: 1,
						supportsApiKeyLogin: true,
						supportsOAuth: false,
						credentials: {
							apiKeys: [
								{ id: "key-first", label: "First key", suffix: "1111", active: true },
								{ id: "key-second", label: "Second key", suffix: "2222", active: false },
								{ id: "key-third", label: "Third key", suffix: "3333", active: false },
							],
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
				providers: [],
				hiddenPlaceholder: "••••••",
			}));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("POST", "/api/providers/api-key/delete", ({ body }) => {
				deleted = body;
				return { ok: true };
			});
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
import {ConfirmModal} from '/js/app.js';
import {Overlay} from '/js/ui.js';
import {useStore} from '/js/store.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await wait(40)}throw Error('timed out waiting for the UI')};
const pickSelect=async(triggerSelector,optionText)=>{const trigger=document.querySelector(triggerSelector);check(trigger,'select trigger missing: '+triggerSelector);trigger.click();await until(()=>document.querySelector('.popover.select-pop:not(.closing) [role=option]'));const options=[...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')];const hit=options.find(el=>el.textContent.includes(optionText));check(hit,'select option missing: '+optionText);hit.click();await wait(120);};
function Host(){
 const dialog=useStore(s=>s.view.dialog);
 return h('div',null,h(ProvidersPage,{}),h(Overlay,{show:dialog?.type==='confirm'},dialog?.type==='confirm'?h(ConfirmModal,{dialog}):null));
}
try {
 setLang('en');
 render(h(Host,{}),document.getElementById('app'));
 await until(()=>[...document.querySelectorAll('.prov-item')].some(el=>el.textContent.includes('Demo')));
 [...document.querySelectorAll('.prov-item')].find(el=>el.textContent.includes('Demo')).click();
 await until(()=>document.querySelector('.key-current button'));
 [...document.querySelector('.key-current').querySelectorAll('button')].find(el=>el.textContent.includes('Manage')).click();
 await until(()=>document.querySelector('.key-replace, .key-list'));
 // Ask to delete the active key while others exist: the replacement row appears with the first other key shown.
 [...document.querySelectorAll('.key-row.active button')].find(el=>el.textContent.includes('Delete')).click();
 await until(()=>document.querySelector('.key-replace .select-like'));
 const trigger=document.querySelector('.key-replace .select-like');
 check(trigger.getAttribute('id')==='rep-key-first','the replacement Select lost its rep- id: '+trigger.getAttribute('id'));
 check(trigger.textContent.includes('Second key'),'the replacement does not default to the first other key: '+trigger.textContent);
 // Pick the second alternative: the submitted replacement must be that key.
 await pickSelect('.key-replace .select-like','Third key');
 check(document.querySelector('.key-replace .select-like').textContent.includes('Third key'),'the trigger does not show the picked key');
 [...document.querySelector('.key-replace').querySelectorAll('button')].find(el=>el.textContent.includes('Delete')).click();
 await until(()=>document.querySelector('.modal'));
 [...document.querySelectorAll('.modal button')].find(el=>el.textContent.includes('Delete API key')).click();
 let submitted=null;
 await until(async()=>{try{submitted=await (await fetch('/api/test/deleted')).json();}catch(e){}return submitted&&submitted.keyId;});
 check(submitted.keyId==='key-first'&&submitted.replacementKeyId==='key-third','wrong payload submitted: '+JSON.stringify(submitted));
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			// The page reads the submitted payload back through this route.
			server.route("GET", "/api/test/deleted", () => deleted ?? {});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Provider key replacement select test",
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
