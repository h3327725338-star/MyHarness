import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// A message sent while a run is active is queued: it shows in the queue at once and never flashes into the transcript.
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1")(
	"keeps a queued message out of the transcript and does not reread it",
	async () => {
		const installed = detectInstalledBrowsers();
		expect(installed.length).toBeGreaterThan(0);
		const root = join(process.env.MYHARNESS_TEMP_DIR!, `queued-send-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			const snap = {
				slot: "test",
				mode: "coding",
				cwd: "C:/fixture",
				session: { id: "chat", file: "test.jsonl", persisted: true },
				flags: {},
				active: true,
				model: { id: "test", name: "Test", input: ["text"] },
				dialogs: [],
				surface: { widgets: {}, statuses: {} },
				queue: { steering: [], followUp: [] },
				thinking: { levels: [], supported: false },
				trust: {},
				run: {},
				app: {},
				workspace: { name: "fixture", rootPath: "C:/fixture" },
			};
			// The server keeps what was sent (a reload shows it) but never pushes an event about it.
			const stored = [{ kind: "user", text: "old question", id: "old-1", ts: 1 }];
			server.route("GET", "/api/boot", () => ({ phase: "ready" }));
			server.route("GET", "/api/state", () => snap);
			server.route("GET", "/api/workspaces", () => ({ workspaces: [], sessions: [] }));
			server.route("GET", "/api/slots", () => ({ slots: [] }));
			server.route("GET", "/api/models", () => ({ models: [] }));
			server.route("GET", "/api/resources", () => ({ commands: [] }));
			server.route("GET", "/api/git/status", () => ({ isRepository: false, gitAvailable: true }));
			server.route("GET", "/api/context", () => ({}));
			server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
			server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
			server.route("GET", "/api/changes", () => ({ files: [], total: 0 }));
			server.route("GET", "/api/settings", () => ({}));
			server.route("POST", "/api/modes/state", () => ({ ok: true }));
			server.route("POST", "/api/sessions/touched", () => ({ ok: true }));
			server.route("POST", "/api/seen", () => ({ ok: true }));
			server.route("POST", "/api/prefs", () => ({ ok: true }));
			let transcriptReads = 0;
			server.route("GET", "/api/transcript", () => {
				transcriptReads++;
				return { items: stored };
			});
			server.route("GET", "/api/test-reads", () => ({ transcriptReads }));
			server.route("POST", "/api/prompt", ({ body }) => {
				const input = body as { text: string };
				// Like the real host: a steer is queued (queue_update) and acknowledged, with no prompt_settled.
				server.broadcast("queue_update", { slot: "test", steering: [input.text], followUp: [] });
				return { ok: true };
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {App} from '/js/app.js';
import {boot,state,canSendToActive} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let i=0;i<300;i++){if(fn())return true;await wait(50)}return false};
try {
 await boot();
 await until(()=>state.connected&&canSendToActive());
 render(h(App),document.getElementById('app'));
 await wait(300);
 const el=document.querySelector('.draft');
 if(!el) throw Error('no composer');
 el.focus();
 el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'queued-message'}));
 await wait(60);
 const before=(await (await fetch('/api/test-reads')).json()).transcriptReads;
 let flashed=false,queuedAt=-1;const t0=performance.now();
 const has=sel=>[...document.querySelectorAll(sel)].some(n=>n.textContent.includes('queued-message'));
 el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await new Promise(done=>{const tick=()=>{if(has('.transcript .user-text'))flashed=true;if(queuedAt<0&&has('.queue-item'))queuedAt=performance.now()-t0;if(performance.now()-t0>4500)return done();requestAnimationFrame(tick)};tick()});
 const after=(await (await fetch('/api/test-reads')).json()).transcriptReads;
 const problems=[];
 if(flashed)problems.push('message drawn in transcript');
 if(queuedAt<0||queuedAt>150)problems.push('queue chip at '+queuedAt);
 if(!has('.queue-item'))problems.push('queue chip gone');
 if(after!==before)problems.push('transcript reread '+(after-before));
 document.body.insertAdjacentHTML('beforeend','<pre id="ready">'+(problems.length?'FAILED '+problems.join('; '):'passed')+'</pre>');
}catch(e){document.body.insertAdjacentHTML('beforeend','<pre id="ready">'+e.stack+'</pre>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Queued send",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	90000,
);
