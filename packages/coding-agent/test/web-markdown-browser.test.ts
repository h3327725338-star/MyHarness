import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_MARKDOWN_BROWSER_E2E !== "1" || !installed.length)(
	"renders and edits Markdown in a real browser, saving Markdown rather than HTML",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-md-browser-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({ kind: installed[0]!.kind, rootDir: join(root, "browser") });
		try {
			writeFileSync(join(root, "doc.md"), "# Original\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n");
			server.mount({ prefix: "/js/", directory: fileURLToPath(new URL("../web/js", import.meta.url)) });
			server.mount({ prefix: "/vendor/", directory: fileURLToPath(new URL("../web/vendor", import.meta.url)) });
			server.mount({
				prefix: "/markdown/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
			});
			registerFileRoutes(server, { session: { sessionManager: { getCwd: () => root } } } as unknown as WebHost);
			const script = `import {h,render} from '/vendor/preact.js';
import {MarkdownEditor} from '/js/markdown-editor.js';
const file = await fetch('/api/files/read?path=doc.md').then(r=>r.json());
render(h(MarkdownEditor,{file,path:'doc.md'}),document.getElementById('app'));
const wait=setInterval(()=>{
 if(!document.querySelector('[contenteditable=true] h1')) return;
 clearInterval(wait);
 try {
  const title=document.querySelector('[contenteditable=true] h1');
  if(!title || document.querySelectorAll('.markdown-edit-body li').length!==2) throw Error('not rendered');
  title.textContent='Edited title'; title.parentElement.dispatchEvent(new Event('input',{bubbles:true}));
  const code=document.querySelector('.markdown-edit-body pre code');
  code.textContent='const y = 2;'; code.closest('.markdown-edit-block').dispatchEvent(new Event('input',{bubbles:true}));
  setTimeout(()=>document.querySelector('.markdown-editor button').click(),100);
  const check=setInterval(async()=>{
   const saved=await fetch('/api/files/read?path=doc.md').then(r=>r.json());
   if(saved.content.includes('# Edited title') && saved.content.includes('const y = 2;')) {clearInterval(check); document.body.insertAdjacentHTML('beforeend','<p id="ready">saved</p>');}
  },100);
 } catch(error) { document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>'); }
},100);`;
			writeFileSync(join(root, "test.js"), script);
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><div id="app"></div><img src="/hold" hidden><script src="/markdown/marked.min.js"></script><script type="module" src="/test/test.js"></script>',
			);
			server.route("GET", "/hold", async () => {
				await new Promise((resolve) => setTimeout(resolve, 12_000));
				return {};
			});
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Markdown editor test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">saved');
			const saved = readFileSync(join(root, "doc.md"), "utf8");
			expect(saved).toContain("# Edited title");
			expect(saved).toContain("- one\n- two");
			expect(saved).toContain("```ts\nconst y = 2;\n```");
			expect(saved).not.toContain("<h1>");
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90_000,
);
