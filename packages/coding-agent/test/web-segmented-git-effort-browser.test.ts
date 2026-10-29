import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();
it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"slides the segmented highlight, starts Git instructions empty and shows effort Default as a named switch",
	async () => {
		const artifacts = process.env.MYHARNESS_ARTIFACTS_DIR;
		if (!artifacts) throw new Error("MYHARNESS_ARTIFACTS_DIR is required for browser test output");
		const tests = join(artifacts, "tests");
		mkdirSync(tests, { recursive: true });
		const root = mkdtempSync(join(tests, "segmented-git-effort-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((b) => b.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			for (const dir of ["js", "vendor", "css"])
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			server.route("GET", "/api/settings", () => ({ items: [] }));
			// Nothing of the user's own: the box shows nothing, the built-in text stays on the server.
			server.route("GET", "/api/git/preferences", () => ({
				commit: {
					mode: "instructions",
					skipHooks: false,
					instructions: "",
					isDefault: true,
					defaultInstructions: "BUILT-IN COMMIT RULES",
				},
				push: { mode: "direct", instructions: "", isDefault: true, defaultInstructions: "BUILT-IN PUSH RULES" },
			}));
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><script src="/js/boot-theme.js"></script><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="seg"></div><div id="effort" style="position:fixed;left:520px;top:420px"></div><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import {h,html,render,useState,Segmented} from '/js/ui.js';
import {SettingsModal} from '/js/overlays-settings.js';
import {EffortPicker} from '/js/model-menu.js';
import {set,setView} from '/js/store.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 // 1. The highlight is one element on the chosen button, and it moves (with a transition) to a new choice.
 function Seg(){const [v,setV]=useState('direct');return html\`<\${Segmented} value=\${v} onChange=\${setV} options=\${[{value:'direct',label:'Direct'},{value:'instructions',label:'With instructions'}]} />\`;}
 render(h(Seg,{}),document.getElementById('seg'));await wait(50);
 const thumb=document.querySelector('#seg .segmented-thumb');
 if(!thumb) throw Error('no sliding highlight');
 const at=()=>{const on=document.querySelector('#seg .segmented button.on');return {on,x:on.offsetLeft,w:on.offsetWidth};};
 let place=at();
 if(thumb.style.width!==place.w+'px'||!thumb.style.transform.startsWith('translate('+place.x+'px')) throw Error('highlight not on the chosen button: '+thumb.style.transform+' '+thumb.style.width);
 if(getComputedStyle(place.on).backgroundColor!=='rgba(0, 0, 0, 0)') throw Error('the chosen button draws its own background');
 document.querySelectorAll('#seg .segmented button')[1].click();await wait(20);
 place=at();
 if(place.on.textContent!=='With instructions') throw Error('choice did not change');
 if(!thumb.style.transform.startsWith('translate('+place.x+'px')||thumb.style.width!==place.w+'px') throw Error('highlight did not move: '+thumb.style.transform);
 if(!getComputedStyle(thumb).transitionProperty.includes('transform')) throw Error('highlight does not slide: '+getComputedStyle(thumb).transitionProperty);

 // 2. Settings → Git: the instructions box starts empty and says the built-in instructions apply.
 set({settings:{items:[]}});
 setView({theme:'dark',lang:'en',motion:'off',settingsSection:'git'});
 render(h(SettingsModal,{}),document.getElementById('app'));await wait(400);
 const toggle=document.querySelector('.git-instr-toggle');
 if(!toggle) throw Error('missing instructions section');
 toggle.click();await wait(300);
 const box=document.querySelector('.git-instructions textarea');
 if(!box) throw Error('missing instructions box');
 if(box.value!=='') throw Error('instructions box is not empty: '+box.value);
 if(!box.placeholder.includes('built-in instructions are used')) throw Error('placeholder missing: '+box.placeholder);
 if(document.body.textContent.includes('Restore default')) throw Error('Restore default is still shown');
 render(null,document.getElementById('app'));

 // 3. Seven levels and "Default": every name has room, and Default is a switch named with the level it stands for, not
 //    a stop left of "off" that reads as the lowest level.
 function Effort(){const [v,setV]=useState(undefined);return html\`<\${EffortPicker} levels=\${['off','minimal','low','medium','high','xhigh','max']} value=\${v} withDefault defaultLevel="off" onChange=\${setV} />\`;}
 render(h(Effort,{}),document.getElementById('effort'));
 await wait(30);
 const chip=document.querySelector('#effort button');
 if(chip.textContent.trim()!=='Default (off)') throw Error('the chip does not say what Default is: '+chip.textContent);
 chip.click();await wait(350);
 const labels=[...document.querySelectorAll('.effort-pop .effort-label')];
 if(labels.length!==7) throw Error('expected 7 effort names, got '+labels.length);
 const boxes=labels.map(el=>el.getBoundingClientRect());
 for(let i=1;i<boxes.length;i++) if(boxes[i].left<boxes[i-1].right) throw Error('effort names overlap at '+i);
 const sw=document.querySelector('.effort-pop .effort-default');
 if(!sw||sw.textContent.trim()!=='Default (off)') throw Error('no Default switch: '+(sw&&sw.textContent));
 const isOn=()=>sw.querySelector('[role=switch]').getAttribute('aria-checked');
 if(isOn()!=='true') throw Error('the Default switch is not on');
 const ghost=document.querySelector('.effort-pop .effort-thumb.ghost');
 if(!ghost||ghost.style.left!=='0%') throw Error('no hollow thumb on off: '+(ghost&&ghost.style.left));
 // Picking a level turns Default off and puts a solid thumb there.
 document.querySelector('.effort-pop .effort-track').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
 await wait(80);
 if(isOn()!=='false') throw Error('Default stays on after a level was picked');
 if(!document.querySelector('.effort-pop .effort-thumb:not(.ghost)')) throw Error('no thumb on the picked level');
 if(chip.textContent.trim()!=='max') throw Error('the chip does not show the picked level: '+chip.textContent);
 // And back: the switch gives the job no level of its own again.
 sw.querySelector('[role=switch]').click();await wait(80);
 if(isOn()!=='true'||chip.textContent.trim()!=='Default (off)') throw Error('Default did not come back: '+chip.textContent);
 document.body.insertAdjacentHTML('beforeend','<p id="ready">passed</p>');
} catch(error) {document.body.insertAdjacentHTML('beforeend','<p id="ready">'+error.message+'</p>');}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Segmented, Git instructions and effort test",
				isSolved: (p) => p.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
		}
	},
	60000,
);
