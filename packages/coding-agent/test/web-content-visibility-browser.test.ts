// W192: row-level content-visibility decisions, locked in.
// The .dl rule predates this ticket (HEAD panels.css); .cfile and .turn .step measured no gain
// and were NOT added. This file locks that exact end state plus the anchor/find behaviour
// that content-visibility must not break.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const panelsCss = readFileSync(new URL("../web/css/panels.css", import.meta.url), "utf8");
const transcriptCss = readFileSync(new URL("../web/css/transcript.css", import.meta.url), "utf8");

describe("long-list content-visibility (W192)", () => {
	it("keeps the .dl rule and adds nothing on .cfile or .turn .step", () => {
		expect(panelsCss).toMatch(
			/\.dl, \.ds-row, \.cl \{ content-visibility: auto; contain-intrinsic-block-size: auto 1\.55em; \}/,
		);
		expect(panelsCss).not.toMatch(/\.cfile \{[^}]*content-visibility/);
		expect(transcriptCss).not.toMatch(/\.turn \.step \{[^}]*content-visibility/);
	});
});

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"scrolls to an off-screen diff row within 2px and finds its text from a collapsed state",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "myharness-cv-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["css", "vendor"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/panels.css"><div class="cdiff" id="scroller" style="height:200px;overflow-y:auto"><div class="diff" id="rows"></div></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
const rows=document.getElementById('rows');
for(let i=0;i<300;i++){ const d=document.createElement('div'); d.className='dl'; d.innerHTML='<span class="dl-no">'+(i+1)+'</span><span class="dl-no"></span><span class="dl-sign"> </span><span class="dl-text">line body '+(i+1)+' w192marker-'+(i+1)+'</span>'; rows.appendChild(d); }
try {
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const style=getComputedStyle(rows.children[0]);
 if(style.contentVisibility!=='auto') throw Error('dl not auto: '+style.contentVisibility);
 // Anchor: scrollIntoView a late row, then compare its viewport top against the scroller top.
 const target=rows.children[250];
 target.scrollIntoView({block:'start'});
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const scroller=document.getElementById('scroller');
 const gap=Math.abs(target.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
 if(gap>2) throw Error('anchor gap '+gap);
 // Find: an off-screen row's text is searchable (selection range over its node succeeds).
 const late=rows.children[280];
 const range=document.createRange(); range.selectNodeContents(late.querySelector('.dl-text'));
 const sel=getSelection(); sel.removeAllRanges(); sel.addRange(range);
 if(!sel.toString().includes('w192marker-281')) throw Error('selection missed: '+sel.toString().slice(0,60));
 sel.removeAllRanges();
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.stack+'</p>'); }
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Content-visibility anchor and find",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	60000,
);
