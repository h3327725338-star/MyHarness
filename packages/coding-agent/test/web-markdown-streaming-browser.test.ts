import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

// A streaming answer shows a code block that has not closed yet as a code block, not as plain text until its closing
// fence arrives (FinalTail in transcript.js); the rest of the streaming tail stays plain.
const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"a code block that is still streaming shows as a code block",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "md-streaming-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((item) => item.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.mount({
				prefix: "/vendor-md/",
				directory: fileURLToPath(new URL("../src/exports/html/vendor", import.meta.url)),
				files: ["marked.min.js", "highlight.min.js"],
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/transcript.css"><script src="/vendor-md/marked.min.js"></script><script src="/vendor-md/highlight.min.js"></script><div id="app" style="height:900px;display:flex;flex-direction:column"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,render} from '/vendor/preact.js';
import {Transcript} from '/js/transcript.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const must=(x,m)=>{if(!x)throw Error(m)};
const F='\\u0060\\u0060\\u0060';
const snap={cwd:'C:/t',active:true,trust:{trusted:true},flags:{},session:{id:'s1',file:'C:/fixture/s1.jsonl'},thinking:{},run:{},queue:{},app:{}};
const user={kind:'user',id:'u1',ts:1,text:'give me an exercise',images:[]};
const answer=(text,done)=>({kind:'assistant',id:'a1',liveId:'L1',ts:2,model:'m',blocks:[{type:'text',text}],stopReason:'stop',...(done?{final:text}:{})});
const show=async(text,done=false)=>{set({items:[user,answer(text,done)],snap,toolRuns:{},dialogs:[],runs:{},userBash:{},userBashOrder:[]});await wait(250);};
const final=()=>document.querySelector('.final');
const blocks=()=>[...final().querySelectorAll('.code-block code')].map((n)=>n.textContent);
const tails=()=>[...final().querySelectorAll('.final-tail')].map((n)=>n.textContent);
try{
 setView({lang:'en',motion:'off'});
 await show('Intro.');
 render(h(Transcript,{}),document.getElementById('app'));
 await wait(300);
 // An open fence, with a blank line inside the code: the block streams as code; the paragraph above is rendered.
 const open='Two exercises. No skeleton this time.\\n\\n### Exercise 3 (Medium): a struct through a pointer\\n\\n'+F+'cpp\\n#include <iostream>\\nusing namespace std;\\n\\nstruct student {\\n    string name;\\n';
 await show(open);
 must(final()?.classList.contains('streaming'),'the answer is not streaming');
 must(blocks().length===1&&blocks()[0].includes('struct student')&&blocks()[0].includes('#include'),'open code block not shown as code: blocks='+JSON.stringify(blocks())+' tails='+JSON.stringify(tails()));
 must(!tails().some((t)=>t.includes('#include')||t.includes(F)),'code leaked into the plain tail: '+JSON.stringify(tails()));
 must(final().querySelector('.code-lang')?.textContent==='cpp','language label: '+final().querySelector('.code-lang')?.textContent);
 // Text right before a fence (no blank line between) stays plain; the block below it is code.
 await show('Intro paragraph.\\n\\nWrite this:\\n'+F+'js\\nlet total = 0;');
 must(JSON.stringify(tails())===JSON.stringify(['Write this:'])&&blocks().length===1&&blocks()[0].includes('let total'),'text before the fence: tails='+JSON.stringify(tails())+' blocks='+JSON.stringify(blocks()));
 // A block that closed but has no blank line after it yet: code, then the plain rest.
 await show(open+'};\\n'+F+'\\nThen run');
 must(blocks().length===1&&blocks()[0].trim().endsWith('};')&&tails().includes('Then run'),'closed block in the tail: tails='+JSON.stringify(tails())+' blocks='+JSON.stringify(blocks()));
 // Plain paragraphs still stream as plain text (unclosed markers do not flicker).
 await show('Intro.\\n\\nThe **number');
 must(JSON.stringify(tails())===JSON.stringify(['The **number'])&&blocks().length===0,'plain tail: '+JSON.stringify(tails()));
 // The finished answer is one Markdown body.
 const whole=open+'};\\n'+F+'\\n\\nExpected output: Mamat 22.';
 await show(whole,true);
 must(!final().classList.contains('streaming')&&tails().length===0&&blocks().length===1&&final().textContent.includes('Expected output'),'final answer: tails='+JSON.stringify(tails())+' blocks='+blocks().length);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
}catch(error){document.body.insertAdjacentHTML('beforeend','<p id="ready">'+String(error.stack||error)+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Markdown streaming",
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
