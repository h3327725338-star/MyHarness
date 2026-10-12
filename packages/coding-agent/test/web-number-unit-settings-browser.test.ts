import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

/** The compact retry selector and unit-in-title number rows on the Network page. */
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"keeps retry values and timeout units in compact controls in both locales",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-number-unit-"));
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
				value: 25,
				min: 0,
				max: 9007199254740991,
				units: [
					{ value: "times", label: "times" },
					{ value: "unlimited", label: "Unlimited", fixed: "unlimited" },
				],
			},
			{
				id: "webShutdownGraceSeconds",
				section: "Network",
				label: "Web UI exit delay (seconds)",
				description: "After the last browser page closes, MyHarness waits before it stops.",
				type: "number",
				value: 10,
				min: 0,
				max: 3600,
				unit: "seconds",
			},
			{
				id: "worktreeShutdownGraceSeconds",
				section: "Network",
				label: "Copy tab exit delay (seconds)",
				description: "After the last copy tab closes, exit after this delay.",
				type: "number",
				value: 10,
				min: 0,
				max: 3600,
				unit: "seconds",
			},
			{
				id: "network.connectTimeoutMs",
				section: "Timeouts & retries",
				label: "Connect timeout (seconds)",
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
				label: "First-byte timeout (seconds)",
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
				label: "Stream idle timeout (seconds)",
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
				label: "Attempts per model (times, first included)",
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
import {setLang} from '/js/lang.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,message)=>{if(!ok)throw Error(message)};
const rowByLabel=(label)=>[...document.querySelectorAll('.set-row')].find(r=>r.querySelector('.set-label')?.textContent===label);
const rowStarting=(label)=>[...document.querySelectorAll('.set-row')].find(r=>r.querySelector('.set-label')?.textContent.startsWith(label));
const pickSelect=async(trigger,optionText)=>{trigger.click();await wait(350);const options=[...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')];const hit=options.find(el=>el.textContent.trim()===optionText);assert(hit,'select option missing: '+optionText);hit.click();await wait(200);};
const openOptions=async(trigger)=>{trigger.click();await wait(350);return [...document.querySelectorAll('.popover.select-pop:not(.closing) [role=option]')];};
const closeOptions=async(trigger)=>{trigger.click();await wait(250);};
const typeAndLeave=(input,value)=>{input.focus();input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.blur();};
const expectedTitles={
 zh:['自动重试次数','Web UI 退出等待时间（秒）','副本标签页关闭后退出等待时间（秒）','建连超时（秒）','首包超时（秒）','静默超时（秒）','同一模型最多尝试次数（次，含第一次）'],
 en:['Auto-retry attempts','Web UI exit delay (seconds)','Copy tab exit delay (seconds)','Connect timeout (seconds)','First-byte timeout (seconds)','Stream idle timeout (seconds)','Attempts per model (times, first included)']
};
try {
 document.documentElement.dataset.motion='off';
 document.documentElement.dataset.theme='dark';
 set({snap:{session:{id:'test'},active:false},models:[]});
 setView({lang:'zh-CN',settingsSection:'network'});
 render(h(SettingsModal,{}),document.getElementById('app'));
 const rows=()=>[...document.querySelectorAll('.set-row')];
 const labels=()=>rows().map(r=>r.querySelector('.set-label')?.textContent||'');
 const retryIsLoaded=()=>rowByLabel('自动重试次数')?.querySelector('.select-like')?.textContent.trim()==='25';
 for(let i=0;i<40&&(!expectedTitles.zh.every(title=>labels().some(label=>label.startsWith(title)))||!retryIsLoaded());i++) await wait(50);
 const retry=rowByLabel('自动重试次数');
 const connect=rowStarting('建连超时');
 const firstByte=rowStarting('首包超时');
 const idle=rowStarting('静默超时');
 const grace=rowStarting('Web UI 退出等待时间');
 const copyGrace=rowStarting('副本标签页关闭后退出等待时间');
 const attempts=rowStarting('同一模型最多尝试次数（次，含第一次）');
 assert(retry&&connect&&firstByte&&idle&&grace&&copyGrace&&attempts,'all seven rows render');
 for(const title of expectedTitles.zh) assert(labels().some(label=>label.startsWith(title)),'missing Chinese title '+title);
 const retrySelect=retry.querySelector('.select-like');
 assert(retrySelect&&retrySelect.getAttribute('aria-label')==='自动重试次数','retry trigger keeps its label');
 assert(retrySelect.textContent.trim()==='25'&&retrySelect.getBoundingClientRect().width<208,'retry is one compact select with 25 selected');
 assert(retry.querySelectorAll('.select-like').length===1&&!retry.querySelector('.group-input, .group-unit'),'retry row has only one select and no number/unit pair');
 const retryOptions=await openOptions(retrySelect);
 assert(retryOptions.length===23,'retry selector has 0, 1–20, the stored extra value, and Unlimited; got '+retryOptions.length);
 assert(retryOptions.slice(0,21).map(o=>o.textContent.trim().replace('（不重试）','')).join(',')===Array.from({length:21},(_,n)=>String(n)).join(','),'retry selector contains every value from 0 through 20');
 assert(retryOptions[0].textContent.trim()==='0（不重试）'&&retryOptions[22].textContent.trim()==='无限','zero and unlimited are translated');
 assert(retryOptions[21].textContent.trim()==='25'&&retryOptions[21].getAttribute('aria-selected')==='true','stored 25 is retained and selected as an extra option');
 await closeOptions(retrySelect);
 for(const row of [connect,firstByte,idle,grace,copyGrace,attempts]) {
  assert(!row.querySelector('span.group-unit')&&!row.querySelector('.select-like.group-unit'),'unit is in the title, not a right-side unit box');
  const input=row.querySelector('input.field.num');
  assert(input,'unit row uses the compact number field');
  assert(input.getBoundingClientRect().width>=76&&input.getBoundingClientRect().width<=84,'unit row number input is not compact: '+input.getBoundingClientRect().width);
 }
 assert(connect.querySelector('input').value==='10','10000 ms shows as 10 seconds');
 assert(firstByte.querySelector('input').value==='60'&&idle.querySelector('input').value==='60','60000 ms values show as 60 seconds');
 assert(grace.querySelector('input').value==='10'&&copyGrace.querySelector('input').value==='10','grace periods remain stored/displayed in seconds');
 assert(attempts.querySelector('input').value==='2','network attempt count remains numeric');
 const notes=()=>[...document.querySelectorAll('.set-note')].map(n=>n.textContent);
 assert(notes().some(n=>n.startsWith('断连不设时限')),'the disconnect note remains shown');
 assert(notes().includes('按当前设置，单次请求最长等待约 2.3 分钟。'),'estimate remains 2 x (10 + 60) s = 2.3 minutes; got '+notes().join('|'));
 await pickSelect(retrySelect,'无限');
 await wait(300);
 typeAndLeave(firstByte.querySelector('input'),'90');
 for(let i=0;i<100&&!notes().includes('按当前设置，单次请求最长等待约 3.3 分钟。');i++) await wait(50);
 assert(notes().includes('按当前设置，单次请求最长等待约 3.3 分钟。'),'estimate follows the edited timeout; got '+notes().join('|'));
 const idleInput=idle.querySelector('input');
 const validBorder=getComputedStyle(idleInput).borderColor;
 idleInput.focus();idleInput.value='0';idleInput.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'0'}));
 for(let i=0;i<20&&!idleInput.classList.contains('invalid');i++) await wait(50);
 assert(idleInput.classList.contains('invalid'),'an out-of-range timeout turns red while typing');
 assert(getComputedStyle(idleInput).borderColor!==validBorder,'an invalid number field has a different border color; got '+getComputedStyle(idleInput).borderColor+' vs '+validBorder);
 idleInput.blur();
 for(let i=0;i<20&&rowStarting('静默超时').querySelector('input').value!=='60';i++) await wait(50);
 assert(rowStarting('静默超时').querySelector('input').value==='60','an out-of-range timeout is restored');
 setLang('en');
 setView({lang:'en',settingsSection:'agent'});
 await wait(100);
 setView({lang:'en',settingsSection:'network'});
 await wait(200);
 const englishLabels=labels();
 for(const title of expectedTitles.en) assert(englishLabels.some(label=>label.startsWith(title)),'missing English title '+title);
 for(const row of rows().filter(r=>expectedTitles.en.slice(1).some(title=>r.querySelector('.set-label')?.textContent.startsWith(title)))) {
  assert(!row.querySelector('span.group-unit')&&!row.querySelector('.select-like.group-unit'),'English unit row has no unit box');
 }
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
