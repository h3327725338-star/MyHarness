import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"drops the detection notice the moment the model entry it came from is removed",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-detect-notice-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			// Only the IDs the form names are answered, the way the real endpoint does it.
			const catalogue: Record<string, Record<string, unknown>> = {
				"gpt-5": { id: "gpt-5", contextWindow: 400000, thinkingSource: "unconfirmed" },
				"gpt-4": { id: "gpt-4", contextWindow: 200000, thinkingSource: "unconfirmed" },
				own: { id: "own", contextWindow: 8000, maxTokens: 1000, reasoning: true, thinkingSource: "catalog" },
			};
			const listed = new Set(["own"]);
			server.route("POST", "/api/providers/custom/detect", ({ body }) => {
				const ids: string[] = (body as { modelIds?: string[] }).modelIds ?? [];
				return {
					ok: true,
					models: ids.map((id) => catalogue[id]).filter(Boolean),
					unlisted: ids.filter((id) => !listed.has(id)),
				};
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {ProviderForm} from '/js/provider-form.js';
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(ok,msg)=>{if(!ok)throw Error(msg)};
const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await wait(40)}throw Error('timed out waiting for the UI')};
const notice=()=>document.querySelector('.pf-detect .notice');
const cards=()=>[...document.querySelectorAll('.pf-model')];
const cardOf=(text)=>cards().find(el=>el.textContent.includes(text));
const emptyHint=()=>document.querySelector('.pf-detect')?.nextElementSibling;
const idsField=()=>document.querySelector('.pf-detect-bar input.field');
const detectButton=()=>document.querySelector('.pf-detect-bar button.btn');
async function detect(text){
 const field=idsField();field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}));await wait(40);
 detectButton().click();await until(()=>notice()&&field.value==='');
}
async function removeModel(text){
 cardOf(text).querySelector('.pf-model-head button.icon-btn').click();await wait(80);
}
try {
 setLang('zh-CN');
 render(h(ProviderForm,{initial:{id:'test',config:{api:'openai-completions',baseUrl:'https://example.invalid/v1',models:[{id:'own',name:'Own'}]}},hasStoredKey:true,onSaved:()=>{},onDirty:()=>{}}),document.getElementById('app'));
 await wait(120);
 check(cards().length===1&&cards()[0].textContent.includes('Own'),'the saved model is not in the form');
 check(!notice(),'a notice shows before anything was detected');

 // The reported case: the detection added one model that was never saved.
 await detect('gpt-5');
 check(notice().textContent.includes('已检测 1 个：新增 1 个，更新 0 个'),'the summary of the detection is wrong: '+notice().textContent);
 check(notice().querySelectorAll('.pf-hint').length===2,'the warnings of the new model are missing: '+notice().textContent);
 check([...notice().querySelectorAll('.pf-hint')].some((el)=>el.textContent.includes('Thinking Effort 无法确认')),'the thinking warning is missing: '+notice().textContent);
 await removeModel('gpt-5');
 await until(()=>!notice());
 check(cards().length===1&&cardOf('Own'),'removing the detected model took a saved model with it');

 // A detection that both added a model and updated a saved one: removing what it added keeps the notice,
 // but only for the update that is really still in the list; removing that too destroys the notice, and an
 // empty list shows the default hint again.
 await detect('own,gpt-4');
 check(notice().textContent.includes('已检测 2 个：新增 1 个，更新 1 个'),'a detection of several IDs is not counted: '+notice().textContent);
 await removeModel('gpt-4');
 await until(()=>notice()&&notice().textContent.includes('已检测 1 个：新增 0 个，更新 1 个'));
 check(notice().querySelectorAll('.pf-hint').length===0,'a warning naming the removed model is still shown: '+notice().textContent);
 check(cards().length===1&&cardOf('Own'),'the update of a saved model was undone by removing another one');
 await removeModel('Own');
 await until(()=>!notice());
 check(cards().length===0,'the updated model is still in the list');
 check(emptyHint()?.textContent.includes('还没有模型'),'the empty list does not show the default hint: '+emptyHint()?.textContent);

 // Adding by hand after that is unaffected, and the notice of the old detection stays gone.
 [...document.querySelectorAll('.set-card-head button')].find(el=>el.textContent.includes('手动添加')).click();await wait(80);
 check(cards().length===1&&!notice(),'a manually added model shows a stale detection notice');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Provider detection notice test",
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
