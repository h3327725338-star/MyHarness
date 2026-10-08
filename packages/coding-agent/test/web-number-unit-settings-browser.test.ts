import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The `numberUnit` rows of the Network page (auto-retry attempts with "Unlimited", HTTP idle timeout typed in
 * minutes/seconds with "Disabled"): they render as one bordered number field plus a unit dropdown, show the stored
 * value in the largest fitting unit, translate in Chinese, and save the exact stored value on the server.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"types a retry count and an idle timeout with their own units and saves the stored value",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-number-unit-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const saved: Array<{ id: string; value: unknown }> = [];
		const items: Array<Record<string, unknown>> = [
			{
				id: "retryMaxRetries",
				section: "Network",
				label: "Auto-retry attempts",
				description: "While auto-retry is on, how many extra attempts a failed model request gets.",
				type: "numberUnit",
				value: 3,
				min: 0,
				max: 9007199254740991,
				units: [
					{ value: "times", label: "times" },
					{ value: "unlimited", label: "Unlimited", fixed: "unlimited" },
				],
			},
			{
				id: "httpIdleTimeoutMs",
				section: "Network",
				label: "HTTP idle timeout",
				description: "Maximum wait without new data while waiting for the model.",
				type: "numberUnit",
				value: 300000,
				min: 0,
				max: 2147483647,
				maxHint: "About 24 days is the longest wait; choose Disabled for no timeout.",
				units: [
					{ value: "minutes", label: "minutes", multiplier: 60000 },
					{ value: "seconds", label: "seconds", multiplier: 1000 },
					{ value: "disabled", label: "Disabled", fixed: 0 },
				],
			},
		];
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/settings", () => ({ items, menu: [], errors: [] }));
			server.route("GET", "/api/state", () => ({ session: { id: "test" }, active: false }));
			server.route("POST", "/api/settings", ({ body }) => {
				const payload = body as { id: string; value: unknown };
				saved.push(payload);
				const item = items.find((i) => i.id === payload.id);
				if (item) item.value = payload.value;
				return { ok: true, errors: [] };
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,message)=>{if(!ok)throw Error(message)};
const rowByLabel=(label)=>[...document.querySelectorAll('.set-row')].find(r=>r.querySelector('.set-label')?.textContent===label);
const setSelect=(select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));};
const typeAndLeave=(input,value)=>{input.focus();input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.blur();};
try {
 document.documentElement.dataset.motion='off';
 set({snap:{session:{id:'test'},active:false},models:[]});
 setView({lang:'zh-CN',settingsSection:'network'});
 render(h(SettingsModal,{}),document.getElementById('app'));
 await wait(400);
 const retry=rowByLabel('自动重试次数');
 const timeout=rowByLabel('HTTP 空闲超时');
 assert(retry&&timeout,'both network rows render');
 assert(retry.querySelector('.unit-input').value==='3','the count shows the typed number');
 assert([...retry.querySelectorAll('option')].map(o=>o.textContent).join('/')==='次/无限','retry units are translated');
 assert(timeout.querySelector('.unit-input').value==='5','300000 ms shows as 5');
 assert(timeout.querySelector('.unit-select').value==='minutes','the largest fitting unit is selected');
 assert([...timeout.querySelectorAll('option')].map(o=>o.textContent).join('/')==='分钟/秒/停用','timeout units are translated');
 // Picking "无限" saves the string at once and the number field goes empty.
 setSelect(retry.querySelector('.unit-select'),'unlimited');
 await wait(300);
 assert(retry.querySelector('.unit-input').disabled===true,'unlimited disables the number');
 // Seconds keep the effective value: 5 minutes retype as 300; typing 90 and leaving saves 90000 ms.
 setSelect(timeout.querySelector('.unit-select'),'seconds');
 await wait(150);
 assert(timeout.querySelector('.unit-input').value==='300','changing the unit keeps the effective value');
 typeAndLeave(timeout.querySelector('.unit-input'),'90');
 await wait(300);
 // "停用" saves 0.
 setSelect(timeout.querySelector('.unit-select'),'disabled');
 await wait(300);
 assert(timeout.querySelector('.unit-input').value==='','disabled shows no number');
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Number-unit settings test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			expect(saved).toEqual([
				{ id: "retryMaxRetries", value: "unlimited" },
				{ id: "httpIdleTimeoutMs", value: 90000 },
				{ id: "httpIdleTimeoutMs", value: 0 },
			]);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
);
