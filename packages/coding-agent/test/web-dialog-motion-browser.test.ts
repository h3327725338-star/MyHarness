import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The dialog motion contract (W144): every dialog family member (ui.js Modal and Overlay, the command panel, the
// command palette, the folder picker) animates with one of exactly four keyframes. The scrim fades in over --t-base
// (160 ms) with scrim-in and out over --t-close (110 ms) with scrim-out; the dialog body rises in over --t-pop (180 ms,
// 8 px slide + 1.5 % scale) with dialog-in and leaves over --t-close (4 px drop + 1 % scale) with dialog-out. Easing
// is --ease-out everywhere. While anything closes it must not intercept clicks and must be gone within 200 ms.
// The fixture renders the real ui.js Overlay+Modal pair in the shape the settings dialog has (app.js:249), the real
// CommandPalette (the same Overlay wrap as app.js:251), the real CommandPanel wired to the real store, and the real
// FolderPicker exactly the way the sidebar mounts it (bare, its own close linger inside), plus a button under the
// scrim to prove the closing animation does not eat clicks.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>';

const testJs = `
import { h, render } from '/vendor/preact.js';
import { Overlay, Modal, useState } from '/js/ui.js';
import { CommandPanel } from '/js/command-panel.js';
import { CommandPalette } from '/js/palette.js';
import { FolderPicker } from '/js/folder-picker.js';
import { state, setView, useStore } from '/js/store.js';

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var assert = function (ok, msg) { if (!ok) throw Error(msg); };
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
window.__clicks = 0;
window.__closes = 0;
window.__folderCloses = 0;
window.__escapes = 0;
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.__escapes += 1; });
var matrix = function (transform) {
	var m = /matrix\\(([^)]+)\\)/.exec(transform || '');
	return m ? m[1].split(',').map(Number) : null;
};
var tyOf = function (transform) { var m = matrix(transform); return m ? m[5] : 0; };
var scOf = function (transform) { var m = matrix(transform); return m ? m[0] : 1; };
var durMsOf = function (duration) {
	var n = parseFloat(duration);
	return duration.indexOf('ms') >= 0 ? n : n * 1000;
};
var animOf = function (el) {
	if (!el) return null;
	var c = getComputedStyle(el);
	return { name: c.animationName, durMs: durMsOf(c.animationDuration), timing: c.animationTimingFunction, fill: c.animationFillMode, pe: c.pointerEvents, opacity: c.opacity, transform: c.transform };
};
var find = async function (sel) {
	for (var i = 0; i < 150; i++) {
		var el = document.querySelector(sel);
		if (el) return { el: el, foundAt: performance.now() };
		await wait(2);
	}
	return null;
};
// Polling for a class that appears after one Preact commit (the closing state); the linger is 110 ms, so this must
// be quick. The headless renderer can stall the animation clock, so every state check here waits for the DOM, never
// for frames; mid-animation values are sampled by pausing the animation and setting currentTime (as in the lab shots).
var poll = async function (sel, maxMs) {
	var t1 = performance.now() + (maxMs || 80);
	for (;;) {
		var el = document.querySelector(sel);
		if (el) return el;
		if (performance.now() > t1) return null;
		await wait(2);
	}
};
var goneMs = async function (el, t0) {
	for (var i = 0; i < 80; i++) {
		if (!document.contains(el)) return Math.round(performance.now() - t0);
		await wait(5);
	}
	return null;
};
var EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
var CENTER = { x: 12, y: 12 };

function TestApp() {
	var dialog = useState(false);
	window.__setDialog = dialog[1];
	var pal = useStore(function (s) { return s.view.palette; });
	var folder = useState(false);
	window.__setFolder = folder[1];
	return h('div', {},
		h('button', { id: 'opener', onClick: function () { dialog[1](true); } }, 'open dialog'),
		h('button', { id: 'under-btn', style: { position: 'fixed', top: '6px', left: '6px' }, onClick: function () { window.__clicks += 1; } }, 'Under'),
		// The settings dialog shape from app.js:249: an Overlay holding a Modal.
		h(Overlay, { show: dialog[0] }, dialog[0] ? h(Modal, { title: 'Settings dialog', class: 'settings-modal', width: 900, onClose: function () { window.__closes += 1; dialog[1](false); } }, h('input', { id: 'dlg-input', class: 'field', autofocus: '' })) : null),
		// The palette from app.js:251.
		h(Overlay, { show: !!pal }, pal ? h(CommandPalette) : null),
		// The command panel, mounted like the app mounts it (reads view.cmd from the store itself).
		h(CommandPanel, {}),
		// The folder picker bare, exactly as the sidebar mounts it (its own exit linger lives inside folder-picker.js).
		h('button', { id: 'folder-opener', onClick: function () { folder[1](true); } }, 'open folder'),
		folder[0] ? h(FolderPicker, { title: 'Add workspace', confirmLabel: 'Add', onClose: function () { window.__folderCloses += 1; folder[1](false); }, onPick: function () { } }) : null);
}

render(h(TestApp, {}), document.getElementById('app'));

if (location.search.indexOf('mode=reduced') >= 0) {
	window.__reducedCheck = async function () {
		document.getElementById('opener').click();
		var found = await find('.modal.settings-modal');
		if (!found) return JSON.stringify({ error: 'dialog not mounted under reduced motion' });
		await wait(20);
		var scrim = found.el.closest('.scrim');
		return JSON.stringify({
			reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
			body: animOf(found.el),
			scrim: animOf(scrim),
		});
	};
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">reduced-ready</p>');
} else {
	(async function () {
		var out = {};
		try {
			await wait(200);
			var rootCs = getComputedStyle(document.documentElement);
			var tPop = parseFloat(rootCs.getPropertyValue('--t-pop'));
			var tClose = parseFloat(rootCs.getPropertyValue('--t-close'));
			var tBase = parseFloat(rootCs.getPropertyValue('--t-base'));
			assert(tPop >= 140 && tPop <= 180, '--t-pop must be 140-180ms, got ' + tPop);
			assert(tClose >= 100 && tClose <= 120, '--t-close must be 100-120ms, got ' + tClose);
			assert(tBase >= 140 && tBase <= 180, 'scrim-in uses --t-base (160ms), got ' + tBase);
			assert(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'host has reduced motion on; the full-motion run needs it off');
			assert(document.documentElement.dataset.motion !== 'off', 'data-motion must not be off for the motion checks');

			// 1. Settings dialog opens: scrim runs scrim-in at --t-base; the body runs dialog-in at --t-pop, both with
			//    --ease-out; the first sample (<25 ms after mount) still shows the slide (8 px) and the scale (0.985).
			document.getElementById('opener').focus();
			window.__setDialog(true);
			var d = await find('.modal.settings-modal');
			assert(d, 'settings dialog never mounted');
			var scrimEl = d.el.closest('.scrim');
			assert(scrimEl && scrimEl.classList.contains('scrim'), 'settings modal is not inside a .scrim');
			// The fixture page loads four <link> stylesheets; on rare runs the module executes and opens the dialog
			// before the last sheet is applied, and the first getComputedStyle reports animation-name none. Wait for
			// the animation style to be applied; the animation clock starts with that application, so the next sample
			// is still early on the curve (the transform range below is what pins the earliness).
			var csScrim = animOf(scrimEl);
			var csBody = animOf(d.el);
			for (var si = 0; si < 750 && (csScrim.name === 'none' || csBody.name === 'none'); si++) {
				await wait(4);
				csScrim = animOf(scrimEl);
				csBody = animOf(d.el);
			}
			out.openDialog = { sampleMsAfterMount: Math.round(performance.now() - d.foundAt), scrim: csScrim, body: csBody };
			assert(csScrim.name === 'scrim-in', 'scrim must run scrim-in on open, got ' + csScrim.name);
			assert(Math.abs(csScrim.durMs - tBase) < 2, 'scrim-in duration must follow --t-base (' + tBase + 'ms), got ' + csScrim.durMs);
			assert(csScrim.timing === EASE, 'scrim-in timing must be --ease-out, got ' + csScrim.timing);
			assert(csBody.name === 'dialog-in', 'dialog body must run dialog-in on open, got ' + csBody.name);
			assert(Math.abs(csBody.durMs - tPop) < 2, 'dialog-in duration must follow --t-pop (' + tPop + 'ms), got ' + csBody.durMs);
			assert(csBody.timing === EASE, 'dialog-in timing must be --ease-out, got ' + csBody.timing);
			var ty0 = tyOf(csBody.transform);
			var sc0 = scOf(csBody.transform);
			assert(ty0 >= 4 && ty0 <= 8.2, 'dialog-in must slide up from 8px below (translateY 4..8 at first sample), got ' + csBody.transform);
			assert(sc0 >= 0.985 && sc0 <= 0.996, 'dialog-in must scale from 0.985 up, got ' + sc0);

			// dialog-in is deterministic at any point of its curve: freeze it at 45 ms (a quarter of --t-pop) and the
			// body must be mid-slide (translateY ≈ 2 px) and mid-fade (opacity ≈ 0.74 with --ease-out), then drop it
			// to rest (cancel: the base style is opacity 1, no transform).
			var dEl = d.el;
			var dAnims = dEl.getAnimations();
			assert(dAnims.length >= 1, 'dialog-in must be running on the body, got ' + dAnims.length + ' animations');
			for (var ai = 0; ai < dAnims.length; ai++) dAnims[ai].pause();
			dAnims[0].currentTime = 45;
			var csMid = animOf(dEl);
			out.mid = { opacity: Number(csMid.opacity), ty: tyOf(csMid.transform), sc: scOf(csMid.transform) };
			assert(out.mid.opacity > 0.45 && out.mid.opacity < 0.95, 'dialog-in at 45ms must be mid-fade (--ease-out ≈ 0.74), got ' + csMid.opacity);
			assert(out.mid.ty > 0.4 && out.mid.ty < 7, 'dialog-in at 45ms must be mid-slide (≈2px of the 8px), got ' + csMid.transform);
			assert(out.mid.sc > 0.985 && out.mid.sc < 0.998, 'dialog-in at 45ms must be mid-scale (0.985→1), got ' + out.mid.sc);
			for (ai = 0; ai < dAnims.length; ai++) dAnims[ai].cancel();
			await wait(20);
			var csRest = animOf(dEl);
			assert(csRest.opacity === '1' && (csRest.transform === 'none' || tyOf(csRest.transform) === 0), 'settled dialog must be opaque and untransformed, got ' + JSON.stringify(csRest));

			// While open the scrim takes the clicks (only the closing animation must let them through).
			var hitOpen = document.elementFromPoint(CENTER.x, CENTER.y);
			assert(hitOpen && hitOpen.id !== 'under-btn', 'open scrim must cover the under button, hit ' + (hitOpen ? hitOpen.id : 'null'));

			// 2. Closing with the header ×: .overlay-host.closing, scrim-out at --t-close with pointer-events none on
			//    the scrim and dialog-out on the body, gone within 200 ms.
			var closeT0 = performance.now();
			dEl.querySelector('.modal-head button').click();
			var host = await poll('.overlay-host.closing');
			assert(host, 'closing class never appeared after the close button');
			var csScrimC = animOf(host.querySelector('.scrim'));
			var csBodyC = animOf(host.querySelector('.modal'));
			out.closing = { scrim: csScrimC, body: csBodyC };
			assert(csScrimC.name === 'scrim-out', 'closing scrim must run scrim-out, got ' + csScrimC.name);
			assert(Math.abs(csScrimC.durMs - tClose) < 2, 'scrim-out duration must follow --t-close (' + tClose + 'ms), got ' + csScrimC.durMs);
			assert(csScrimC.pe === 'none', 'closing scrim must not take clicks, got ' + csScrimC.pe);
			assert(csScrimC.fill === 'both', 'scrim-out must hold its end frame, got ' + csScrimC.fill);
			assert(csBodyC.name === 'dialog-out', 'closing body must run dialog-out, got ' + csBodyC.name);
			assert(Math.abs(csBodyC.durMs - tClose) < 2, 'dialog-out duration must follow --t-close, got ' + csBodyC.durMs);

			// 3. Mid-close the point under the scrim hits the button and the click counts.
			var underHit = document.elementFromPoint(CENTER.x, CENTER.y);
			assert(underHit && underHit.id === 'under-btn', 'clicks must pass through the closing scrim, hit ' + (underHit ? underHit.id : 'null'));
			underHit.click();
			assert(window.__clicks === 1, 'the button under the closing scrim must receive the click, clicks=' + window.__clicks);
			out.closing.removedMs = await goneMs(host, closeT0);
			assert(out.closing.removedMs !== null && out.closing.removedMs <= 200, 'closing dialog must be removed within 200 ms, removed at ' + out.closing.removedMs);
			assert(window.__closes === 1, 'the × must have called onClose exactly once, got ' + window.__closes);

			// 4. Escape closes the dialog (the window-capture listener from ui.js, unchanged): reopen, Esc, Esc again
			//    mid-fade must not double-close; focus returns to the opener.
			window.__escapes = 0;
			var closesBefore = window.__closes;
			window.__setDialog(true);
			var d2 = await find('.modal.settings-modal');
			assert(d2, 'dialog never reopened');
			await wait(250);
			// A real Escape arrives on the focused control (the dialog's own input), not on the body.
			d2.el.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			var host2 = await poll('.overlay-host.closing', 60);
			assert(host2, 'Escape must close the dialog (.overlay-host.closing)');
			assert(document.contains(d2.el), 'the dialog should still be fading out right after Escape');
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await wait(200);
			assert(
				window.__closes === closesBefore + 1,
				'the first Escape must close the dialog exactly once, and a mid-fade Escape must not re-fire onClose, closes=' + window.__closes,
			);
			assert(!document.contains(d2.el), 'dialog must be gone after Escape');
			// W203 moved the hand-back into rAF, and the headless renderer can stall the frame clock, so this waits for
			// the focus to land (polling the DOM, as every other state check here does); the assertion below is unchanged.
			for (var fb = 0; fb < 250 && !(document.activeElement && document.activeElement.id === 'opener'); fb++) await wait(2);
			out.focusBack = document.activeElement && document.activeElement.id;
			assert(out.focusBack === 'opener', 'focus must return to the trigger button, got ' + out.focusBack);
			// The first Escape is consumed by the dialog's own window-capture handler (stopPropagation, unchanged
			// semantics); the mid-fade Escape passes the inert guard and reaches the rest of the page.
			assert(window.__escapes === 1, 'exactly the mid-fade Escape must reach the page listeners: ' + window.__escapes);

			// 5. Command panel: opens with dialog-in (no .fade-in utility class), Escape closes through the same
			//    lingering class .cp.closing with pointer-events none and dialog-out; ArrowDown/Enter on the empty
			//    list must not throw; a click outside also closes.
			setView({ cmd: { name: 'w144probe', arg: '', nonce: Date.now() } });
			var cpF = await find('.cp');
			assert(cpF, 'command panel never mounted');
			assert(!cpF.el.classList.contains('fade-in') && !cpF.el.classList.contains('leaving'), 'cp must not use the old fade-in/leaving classes: ' + cpF.el.className);
			var csCp = animOf(cpF.el);
			assert(csCp.name === 'dialog-in', 'command panel must run dialog-in on open, got ' + csCp.name);
			assert(Math.abs(csCp.durMs - tPop) < 2, 'cp dialog-in duration must follow --t-pop, got ' + csCp.durMs);
			assert(cpF.el.getAttribute('role') === 'dialog', 'cp keeps role=dialog');
			await wait(260);
			var screen = cpF.el.querySelector('.cp-screen');
			assert(screen, 'cp-screen not rendered');
			screen.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
			screen.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			await wait(30);
			assert(document.querySelector('.cp') && !document.querySelector('.cp.closing'), 'ArrowDown+Enter on the empty list must not close or crash the panel');
			out.cpKeyboard = { errors: window.__errors.length };
			var closeCp0 = performance.now();
			screen.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			var cpClosing = await poll('.cp.closing');
			assert(cpClosing, 'Escape must leave the command panel in .cp.closing');
			var csCpC = animOf(cpClosing);
			out.cpClosing = { name: csCpC.name, durMs: csCpC.durMs, pe: csCpC.pe };
			assert(csCpC.name === 'dialog-out', 'cp closing must run dialog-out, got ' + csCpC.name);
			assert(Math.abs(csCpC.durMs - tClose) < 2, 'cp dialog-out must follow --t-close, got ' + csCpC.durMs);
			assert(csCpC.pe === 'none', 'cp closing must not take clicks, got ' + csCpC.pe);
			out.cpClosing.removedMs = await goneMs(cpClosing, closeCp0);
			assert(out.cpClosing.removedMs !== null && out.cpClosing.removedMs <= 200, 'cp must be removed within 200 ms, removed at ' + out.cpClosing.removedMs);
			assert(!state.view.cmd, 'closing the panel must clear view.cmd');
			// mousedown outside also closes (the PanelBody document-capture listener, unchanged behaviour).
			setView({ cmd: { name: 'w144probe2', arg: '', nonce: Date.now() } });
			var cpF2 = await find('.cp');
			assert(cpF2, 'command panel never reopened');
			await wait(250);
			document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 700 }));
			await wait(220);
			assert(!document.querySelector('.cp'), 'a click outside must close the command panel');

			// 6. Command palette: opens with scrim-in + dialog-in; Enter runs the first match (toggle sidebar, no
			//    server needed) and the palette fades out (scrim-out, pe none, gone ≤200 ms); Escape also closes.
			var beforeSidebar = state.view.sidebarOpen;
			setView({ palette: true });
			var pF = await find('.scrim.top > .palette');
			assert(pF, 'palette never mounted');
			var pScrim = pF.el.closest('.scrim');
			var csPS = animOf(pScrim);
			var csPP = animOf(pF.el);
			assert(csPS.name === 'scrim-in' && Math.abs(csPS.durMs - tBase) < 2, 'palette scrim must run scrim-in at --t-base, got ' + JSON.stringify(csPS));
			assert(csPP.name === 'dialog-in' && Math.abs(csPP.durMs - tPop) < 2, 'palette body must run dialog-in at --t-pop, got ' + JSON.stringify(csPP));
			var inp = pF.el.querySelector('.palette-input input');
			assert(inp, 'palette input missing');
			inp.focus();
			inp.value = 'sidebar';
			inp.dispatchEvent(new Event('input', { bubbles: true }));
			await wait(250);
			inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			var pHost = await poll('.overlay-host.closing');
			assert(pHost, 'Enter must close the palette (its entry ran, the palette is fading)');
			assert(state.view.sidebarOpen !== beforeSidebar, 'Enter must have run the matched command (sidebar toggle)');
			var csPSC = animOf(pHost.querySelector('.scrim'));
			assert(csPSC.name === 'scrim-out' && csPSC.pe === 'none', 'closing palette scrim must run scrim-out with pointer-events none, got ' + JSON.stringify(csPSC));
			var pBody = pHost.querySelector('.palette');
			assert(pBody && animOf(pBody).name === 'dialog-out', 'closing palette must run dialog-out');
			assert(await goneMs(pHost, performance.now()) !== null, 'palette host must be removed');
			// Escape also closes.
			setView({ palette: true });
			var pF2 = await find('.scrim.top > .palette');
			assert(pF2, 'palette never reopened');
			await wait(200);
			pF2.el.querySelector('.palette-input input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await wait(220);
			assert(!document.querySelector('.palette'), 'Escape must close the palette');

			// 7. Folder picker (modal path, the sidebar mounts it bare): open with scrim-in + dialog-in; Cancel goes
			//    through the new exit linger: .overlay-host.closing first, then the parent's onClose (exactly once).
			window.__folderCloses = 0;
			window.__setFolder(true);
			var fF = await find('.fp-modal');
			assert(fF, 'folder picker never mounted');
			var fScrim = fF.el.closest('.scrim');
			var csFS = animOf(fScrim);
			assert(csFS.name === 'scrim-in', 'folder picker scrim must run scrim-in, got ' + csFS.name);
			assert(animOf(fF.el).name === 'dialog-in', 'folder picker body must run dialog-in');
			// let its own /api fetches (404 here, caught) settle
			await wait(300);
			var fCloseT0 = performance.now();
			var cancel = fF.el.querySelector('.modal-foot .btn');
			assert(cancel, 'folder picker cancel button missing');
			cancel.click();
			var fHost = await poll('.overlay-host.closing');
			assert(fHost && fHost.querySelector('.fp-modal'), 'Cancel must leave the folder picker in .overlay-host.closing (fade out before unmount)');
			var csFSC = animOf(fHost.querySelector('.scrim'));
			assert(csFSC.name === 'scrim-out' && csFSC.pe === 'none', 'closing folder scrim must fade with pointer-events none, got ' + JSON.stringify(csFSC));
			var fRemoved = await goneMs(fHost, fCloseT0);
			assert(fRemoved !== null && fRemoved <= 220, 'folder picker must be fully gone within 220 ms, removed at ' + fRemoved);
			assert(window.__folderCloses === 1, 'the parent onClose must be called exactly once after the linger, got ' + window.__folderCloses);
			assert(!document.querySelector('.fp-modal'), 'folder picker must be unmounted after closing');

			assert(window.__errors.length === 0, 'page errors: ' + window.__errors.join(' / '));
			document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed ' + JSON.stringify(out) + '</p>');
		} catch (err) {
			document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + ' ' + JSON.stringify(out) + '</p>');
		}
	})();
}
`;

function servePage(root: string) {
	const server = new WebHttpServer();
	for (const dir of ["js", "vendor", "css"]) {
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
	}
	server.mount({ prefix: "/test/", directory: root });
	writeFileSync(join(root, "index.html"), indexHtml);
	writeFileSync(join(root, "test.js"), testJs);
	server.setIndexFile(join(root, "index.html"));
	return server;
}

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"dialog family animates with scrim-in/scrim-out and dialog-in/dialog-out and never blocks clicks",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-dialog-motion-"));
		const server = servePage(root);
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Dialog motion test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"prefers-reduced-motion (CDP emulated) keeps dialogs to a short fade with no slide or scale",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-dialog-reduced-"));
		const server = servePage(root);
		// CDP is only spoken by the Chromium-family browsers; prefer Chrome, then Edge.
		const chosen =
			installed.find((entry) => entry.kind === "chrome") ?? installed.find((entry) => entry.kind === "edge");
		expect(chosen, "this case needs Chrome or Edge for Emulation.setEmulatedMedia").toBeDefined();
		const launch = launchChromium({
			executable: chosen!.executable,
			profileDir: join(root, "chrome"),
			headless: true,
			brand: chosen!.kind === "edge" ? "Microsoft Edge" : "Google Chrome",
		});
		const bridge = launch.bridge as unknown as {
			send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
			quit?(): Promise<void>;
			close(): void;
		};
		try {
			await launch.ready({ timeoutMs: 30000, isAlive: () => launch.child.exitCode === null });
			const { port } = await server.listen(0);
			const created = await bridge.send("Target.createTarget", { url: `http://127.0.0.1:${port}/?mode=reduced` });
			const attached = await bridge.send("Target.attachToTarget", {
				targetId: String(created.targetId),
				flatten: true,
			});
			const sessionId = String(attached.sessionId);
			let ready = false;
			for (let i = 0; i < 150 && !ready; i++) {
				const reply = await bridge
					.send(
						"Runtime.evaluate",
						{ expression: "String(!!window.__reducedCheck)", returnByValue: true },
						sessionId,
					)
					.catch((): Record<string, unknown> => ({}));
				ready = (reply.result as { value?: string } | undefined)?.value === "true";
				if (!ready) await new Promise((r) => setTimeout(r, 200));
			}
			expect(ready, "the reduced-mode fixture page never came up").toBe(true);
			await bridge.send(
				"Emulation.setEmulatedMedia",
				{ features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
				sessionId,
			);
			const evaluated = await bridge.send(
				"Runtime.evaluate",
				{ expression: "window.__reducedCheck()", awaitPromise: true, returnByValue: true },
				sessionId,
			);
			const value = JSON.parse(String((evaluated.result as { value?: string } | undefined)?.value ?? "{}"));
			expect(
				value.error,
				`dialog must mount under reduced motion emulation: ${String(value.error)}`,
			).toBeUndefined();
			expect(value.reduced, "matchMedia must report the emulated reduce").toBe(true);
			expect(value.body.name).toBe("dialog-in");
			expect(value.body.durMs).toBeLessThanOrEqual(60);
			expect(value.body.opacity).toBe("1");
			expect(
				value.body.transform === "none" || /matrix\(1, 0, 0, 1, 0, 0\)/u.test(String(value.body.transform)),
				`no slide or scale may remain under reduced motion, transform=${value.body.transform}`,
			).toBe(true);
			expect(value.scrim.name).toBe("scrim-in");
			expect(value.scrim.durMs).toBeLessThanOrEqual(60);
			expect(value.scrim.opacity).toBe("1");
		} finally {
			await bridge.quit?.().catch(() => {});
			if (launch.child.pid) {
				try {
					launch.child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	90000,
);
