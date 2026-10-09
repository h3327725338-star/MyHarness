import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/**
 * The `numberUnit` rows of the Network page: auto-retry attempts with "Unlimited" (number + unit dropdown), and the
 * three timeouts of the "Timeouts & retries" card typed in seconds (number + fixed unit text, stored in milliseconds).
 * They translate in Chinese and save the exact stored value on the server; the card also shows a note and the longest
 * wait the current numbers add up to.
 */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"types a retry count and the three timeouts with their own units and saves the stored value",
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
				id: "network.connectTimeoutMs",
				section: "Timeouts & retries",
				label: "Connect timeout",
				description: "Longest time to set up a connection.",
				type: "numberUnit",
				value: 10000,
				min: 1000,
				max: 3600000,
				maxHint: "Enter 1 to 3600 seconds.",
				units: [{ value: "seconds", label: "seconds", multiplier: 1000 }],
			},
			{
				id: "network.firstByteTimeoutMs",
				section: "Timeouts & retries",
				label: "First-byte timeout",
				description: "Longest wait until the server starts to answer.",
				type: "numberUnit",
				value: 60000,
				min: 1000,
				max: 3600000,
				maxHint: "Enter 1 to 3600 seconds.",
				units: [{ value: "seconds", label: "seconds", multiplier: 1000 }],
			},
			{
				id: "network.streamIdleTimeoutMs",
				section: "Timeouts & retries",
				label: "Stream idle timeout",
				description: "Longest gap between two pieces of data.",
				type: "numberUnit",
				value: 60000,
				min: 1000,
				max: 3600000,
				maxHint: "Enter 1 to 3600 seconds.",
				units: [{ value: "seconds", label: "seconds", multiplier: 1000 }],
			},
			{
				id: "retry.networkMaxAttempts",
				section: "Timeouts & retries",
				label: "Attempts per model (first included)",
				description: "After this many failed attempts, the fallback model takes over.",
				type: "number",
				value: 2,
				min: 1,
				max: 20,
				unit: "times",
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
 const rowStarting=(label)=>[...document.querySelectorAll('.set-row')].find(r=>r.querySelector('.set-label')?.textContent.startsWith(label));
 const connect=rowStarting('建连超时');
 const firstByte=rowStarting('首包超时');
 const idle=rowStarting('静默超时');
 const attempts=rowStarting('同一模型最多尝试次数（含第一次）');
 assert(retry&&connect&&firstByte&&idle&&attempts,'all rows render with their Chinese labels');
 assert(retry.querySelector('.group-input').value==='3','the count shows the typed number');
 assert([...retry.querySelectorAll('option')].map(o=>o.textContent).join('/')==='次/无限','retry units are translated');
 // The three timeouts are typed in seconds: the unit is fixed text, not a one-entry menu.
 assert(connect.querySelector('.group-input').value==='10','10000 ms shows as 10');
 assert(firstByte.querySelector('.group-input').value==='60','60000 ms shows as 60');
 assert(idle.querySelector('.group-input').value==='60','60000 ms shows as 60');
 for (const row of [connect,firstByte,idle]) {
  assert(!row.querySelector('select'),'a single unit is not a dropdown');
  assert(row.querySelector('span.group-unit')?.textContent==='秒','the fixed unit reads seconds');
 }
 const notes=()=>[...document.querySelectorAll('.set-note')].map(n=>n.textContent);
 assert(notes().some(n=>n.startsWith('断连不设时限')),'the disconnect note is shown');
 assert(notes().includes('按当前设置，单次请求最长等待约 2.3 分钟。'),'estimate: 2 x (10 + 60) s = 2.3 minutes, got '+notes().join('|'));
 // Picking "无限" saves the string at once and the number field goes empty.
 setSelect(retry.querySelector('.group-unit'),'unlimited');
 await wait(300);
 assert(retry.querySelector('.group-input').disabled===true,'unlimited disables the number');
 // Typing 90 seconds and leaving saves 90000 ms, and the estimate follows: 2 x (10 + 90) s = 3.3 minutes.
 typeAndLeave(firstByte.querySelector('.group-input'),'90');
 await wait(400);
 assert(notes().includes('按当前设置，单次请求最长等待约 3.3 分钟。'),'estimate follows the new value, got '+notes().join('|'));
 // 0 is out of range (there is no "no limit"): the box restores and nothing is saved.
 const idleInput=idle.querySelector('.group-input');
 idleInput.focus();idleInput.value='0';idleInput.dispatchEvent(new Event('input',{bubbles:true}));
 await wait(100);
 assert(idleInput.classList.contains('invalid'),'an out-of-range value turns the box red while typing');
 idleInput.blur();
 await wait(300);
 assert(rowStarting('静默超时').querySelector('.group-input').value==='60','an out-of-range value is restored');
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
				{ id: "network.firstByteTimeoutMs", value: 90000 },
			]);
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
);
