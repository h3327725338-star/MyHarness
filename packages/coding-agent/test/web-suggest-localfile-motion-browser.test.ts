import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The W143 contract: the composer suggestion list (.suggest) and the local-file right-click menu (.local-file-menu)
// animate with the shared pop-in/pop-out keyframes (--t-pop open, --t-close exit, --ease-out), keep pointer-events off
// while closing, and leave the DOM within 200 ms. Keyboard behavior and close triggers are unchanged; a menu replaced
// by a newer one is dropped at once. Since W207 the menu carries no focus poll: the window/document listeners it adds
// and its document.body observer exist only while it is open, and a plain window blur never dismisses a healthy menu.
// This fixture renders the real Composer (slash + @ file lists) and calls the real
// showLocalFileMenu against a stubbed /api/files/local.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/composer.css"><div style="height:420px"></div><div id="app" style="height:420px;display:flex;flex-direction:column"></div>' +
	// The server CSP is script-src 'self': the error sink must ship as an external file (sink.js), not inline.
	'<script src="/test/sink.js"></script><script type="module" src="/test/test.js"></script>';

const sinkJs = `
function __pfail(l) {
	if (window.__done || document.getElementById('ready')) return;
	var p = document.createElement('p');
	p.setAttribute('id', 'ready');
	p.textContent = 'FAILED ' + l;
	document.body.appendChild(p);
}
window.__pfail = __pfail;
window.onerror = function (m, s) { __pfail('page-error ' + m + ' @' + s + ' moduleStarted=' + String(!!window.__moduleStarted)); };
window.addEventListener('unhandledrejection', function (e) { __pfail('rej ' + ((e.reason && e.reason.message) || e.reason)); });
`;

const testJs = `
import { h, render } from '/vendor/preact.js';
import { Composer } from '/js/composer.js';
import { set, setView, activeSlotId } from '/js/store.js';
import { showLocalFileMenu } from '/js/local-files.js';

// Heartbeat: if this never appears in a FAILED message, the module graph itself failed to run.
window.__moduleStarted = 1;

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var assert = function (ok, msg) { if (!ok) throw Error(msg); };
var tyOf = function (transform) {
	if (!transform || transform === 'none') return 0;
	var m = /matrix\\(([^)]+)\\)/.exec(transform);
	if (!m) return 0;
	return Number(m[1].split(',')[5]) || 0;
};
var durMsOf = function (duration) {
	var n = parseFloat(duration);
	return duration.indexOf('ms') >= 0 ? n : n * 1000;
};
var findEl = async function (sel) {
	for (var i = 0; i < 150; i++) {
		var el = document.querySelector(sel);
		if (el) return { el: el, mountedAt: performance.now() };
		await wait(2);
	}
	return null;
};
var nonce = 0;
var openSlash = function () { nonce += 1; set({ editorInsert: { text: '/', replace: true, nonce: nonce } }); };
var openAt = function () { nonce += 1; set({ editorInsert: { text: '@', replace: true, nonce: nonce } }); };
var menuPath = 'C:/Docs/report.pptx';
var target = document.createElement('span');
target.id = 'lf-target';
target.setAttribute('data-local-path', menuPath);
document.body.append(target);
var openMenu = function (x, y) {
	return showLocalFileMenu({ preventDefault: function () {}, target: target, clientX: x, clientY: y }, menuPath, activeSlotId());
};
var key = function (el, k) { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };

var baseState = {
	items: [],
	snap: { cwd: 'C:/t', active: false, trust: { trusted: true }, flags: {}, session: { id: 'w143', file: 'C:/fixture/w143.jsonl' }, thinking: {}, run: {}, queue: {}, app: {} },
	surface: { widgets: {}, statuses: {} },
	queue: { steering: [], followUp: [] },
	dialogs: [],
	resources: { commands: [{ name: 'help', description: 'Show help', source: 'builtin', uses: 2 }, { name: 'new', description: 'New chat', source: 'builtin', uses: 1 }], tools: [], skills: [], templates: [], extensions: [] },
};

var reducedCheck = async function () {
	var out = { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
	openSlash();
	var f = await findEl('.suggest');
	if (!f) return JSON.stringify({ error: 'suggest never mounted (reduced)' });
	var cs = getComputedStyle(f.el);
	out.suggest = { name: cs.animationName, durMs: durMsOf(cs.animationDuration), transform: cs.transform, opacity: cs.opacity, shift: cs.getPropertyValue('--pop-shift').trim() };
	await openMenu(160, 160);
	var m = document.querySelector('.local-file-menu:not(.closing)');
	if (!m) return JSON.stringify({ error: 'menu never mounted (reduced)' });
	var cm = getComputedStyle(m);
	out.menu = { name: cm.animationName, durMs: durMsOf(cm.animationDuration), transform: cm.transform, opacity: cm.opacity, shift: cm.getPropertyValue('--pop-shift').trim() };
	return JSON.stringify(out);
};

try {
	set(baseState);
	setView({ lang: 'en' });
	render(h(Composer, {}), document.getElementById('app'));
} catch (e) {
	window.__pfail('boot-error ' + e.message);
}

if (location.search.indexOf('mode=reduced') >= 0) {
	window.__reducedCheck = reducedCheck;
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">reduced-ready</p>');
} else {
	document.documentElement.dataset.motion = 'on';
	// A hung await must report too: solveChallenge would otherwise spin until the vitest timeout with no clue.
	window.__wd = setTimeout(function () { window.__pfail('watchdog-no-ready ' + JSON.stringify(window.__steps || {})); }, 60000);
	(async function () {
		var out = {};
		window.__steps = out;
		var step = function (name) { out.step = name; };
		try {
			await wait(250);
			var rootCs = getComputedStyle(document.documentElement);
			var tPop = parseFloat(rootCs.getPropertyValue('--t-pop'));
			var tClose = parseFloat(rootCs.getPropertyValue('--t-close'));
			assert(tPop >= 140 && tPop <= 180, '--t-pop must be 140-180ms, got ' + tPop);
			assert(tClose >= 100 && tClose <= 120, '--t-close must be 100-120ms, got ' + tClose);
			assert(document.documentElement.dataset.motion === 'on', 'fixture needs motion forced on');

			// ---- 1. Suggestion list opens with pop-in at --t-pop, sliding up from +4px (top placement contract).
			step('slash-open');
			openSlash();
			var s = await findEl('.suggest:not(.closing)');
			assert(s, 'slash suggestion list never mounted');
			var csS = getComputedStyle(s.el);
			var durS = durMsOf(csS.animationDuration);
			out.suggestOpen = {
				sampleMsAfterMount: Math.round(performance.now() - s.mountedAt),
				name: csS.animationName, durMs: durS, timing: csS.animationTimingFunction, fill: csS.animationFillMode,
				shift: parseFloat(csS.getPropertyValue('--pop-shift')), transform: csS.transform,
			};
			assert(out.suggestOpen.sampleMsAfterMount <= 20, 'sampled later than 20ms after mount: ' + out.suggestOpen.sampleMsAfterMount);
			assert(csS.animationName === 'pop-in', 'suggest must animate pop-in, got ' + csS.animationName);
			assert(Math.abs(durS - tPop) < 2, 'suggest duration must follow --t-pop (' + tPop + 'ms), got ' + durS);
			assert(csS.animationTimingFunction === 'cubic-bezier(0.2, 0.8, 0.2, 1)', 'suggest timing must be --ease-out, got ' + csS.animationTimingFunction);
			assert(csS.animationFillMode === 'both', 'suggest fill must be both, got ' + csS.animationFillMode);
			assert(parseFloat(csS.getPropertyValue('--pop-shift')) === 4, 'suggest must slide from +4px (top placement), got ' + csS.getPropertyValue('--pop-shift'));
			var tyS = tyOf(csS.transform);
			assert(tyS >= -0.5 && tyS <= 4.5, 'suggest entrance slides up from below (translateY 0..4), got ' + csS.transform);
			assert(s.el.querySelectorAll('.suggest-item').length >= 2, 'slash list has no rows');

			// ---- 3. While closing, clicks pass through to a control placed under the list.
			var sr = s.el.getBoundingClientRect();
			var cx = Math.round(sr.left + sr.width / 2);
			var cy = Math.round(sr.top + sr.height / 2);
			var under = document.createElement('button');
			under.id = 'suggest-under';
			under.textContent = 'under';
			under.style.cssText = 'position:fixed;left:' + (cx - 20) + 'px;top:' + (cy - 10) + 'px;width:40px;height:20px;z-index:1;';
			window.__underClicks = 0;
			under.addEventListener('click', function () { window.__underClicks += 1; });
			document.body.append(under);
			var hitOpen = document.elementFromPoint(cx, cy);
			assert(hitOpen && s.el.contains(hitOpen), 'open list should cover the point under it, hit ' + (hitOpen ? hitOpen.id || hitOpen.className : 'null'));

			// ---- 2. Esc leaves it mounted in .closing with pop-out at --t-close, pointer-events none, gone within 200ms.
			var area = document.querySelector('.composer-input');
			assert(area, 'composer input not found');
			var closeT0 = performance.now();
			key(area, 'Escape');
			var closing = null;
			for (var i = 0; i < 20 && !closing; i++) { closing = document.querySelector('.suggest.closing'); if (!closing) await wait(5); }
			assert(closing, 'Esc must leave the list in .closing instead of unmounting at once');
			var csC = getComputedStyle(closing);
			out.suggestClosing = { name: csC.animationName, durMs: durMsOf(csC.animationDuration), pointerEvents: csC.pointerEvents };
			assert(csC.animationName === 'pop-out', 'closing suggest must run pop-out, got ' + csC.animationName);
			assert(Math.abs(durMsOf(csC.animationDuration) - tClose) < 2, 'closing duration must follow --t-close (' + tClose + 'ms), got ' + durMsOf(csC.animationDuration));
			assert(csC.pointerEvents === 'none', 'closing suggest must not take clicks, got ' + csC.pointerEvents);
			var midHit = document.elementFromPoint(cx, cy);
			out.clickThrough = { elapsedMs: Math.round(performance.now() - closeT0), hit: midHit ? midHit.id : null };
			assert(midHit && midHit.id === 'suggest-under', 'clicks must pass through the closing list, hit ' + (midHit ? midHit.id || midHit.className : 'null'));
			midHit.click();
			assert(window.__underClicks === 1, 'button under the closing list must receive the click, clicks=' + window.__underClicks);
			var removedMs = null;
			for (var j = 0; j < 60 && removedMs === null; j++) {
				if (!document.contains(closing)) removedMs = Math.round(performance.now() - closeT0);
				else await wait(5);
			}
			out.suggestRemovedMs = removedMs;
			assert(removedMs !== null && removedMs <= 200, 'closing suggest must be removed within 200ms, removed at ' + removedMs);

			// ---- 7a. Keyboard on the list is unchanged: ArrowDown moves the highlight, Enter picks (a @ file inserts).
			step('at-open');
			openAt();
			await wait(350); // the file fetch is debounced by 120ms
			var list2 = document.querySelector('.suggest:not(.closing)');
			assert(list2, '@ file list never mounted');
			var rows = [...list2.querySelectorAll('.suggest-item')];
			assert(rows.length >= 2, 'file list has fewer than 2 rows: ' + rows.length);
			assert(rows[0].getAttribute('aria-selected') === 'true', 'first row must start selected');
			area.focus();
			key(area, 'ArrowDown');
			await wait(30);
			var rows2 = [...document.querySelectorAll('.suggest .suggest-item')];
			assert(rows2[1] && rows2[1].getAttribute('aria-selected') === 'true', 'ArrowDown must move the highlight');
			key(area, 'Enter');
			await wait(30);
			var closing2 = document.querySelector('.suggest.closing');
			out.fileEnter = { closing: !!closing2 };
			assert(closing2, 'Enter on a @ file must insert it and start the closing animation');
			// DraftEditor is a contenteditable div, not a textarea: the inserted text lands in its lines.
			var editorText = (document.querySelector('.composer-input') || { textContent: '' }).textContent || '';
			out.fileEnter.editorText = editorText;
			assert(editorText.indexOf('@src/beta.ts') >= 0, 'Enter must insert the picked file, editor=' + JSON.stringify(editorText));
			for (var k = 0; k < 60 && document.contains(closing2); k++) await wait(5);
			assert(!document.contains(closing2), 'Enter-closed list must also be removed after the fade');

			// ---- 1b/4. Local-file menu: opens with pop-in (slides from -4px), ~180ms.
			step('menu-open');
			var openP = openMenu(240, 260);
			var mm = await findEl('.local-file-menu:not(.closing)');
			assert(mm, 'local-file menu never mounted');
			var csM = getComputedStyle(mm.el);
			out.menuOpen = {
				sampleMsAfterMount: Math.round(performance.now() - mm.mountedAt),
				name: csM.animationName, durMs: durMsOf(csM.animationDuration), timing: csM.animationTimingFunction, fill: csM.animationFillMode,
				shift: parseFloat(csM.getPropertyValue('--pop-shift')), transform: csM.transform,
			};
			assert(out.menuOpen.sampleMsAfterMount <= 20, 'menu sampled later than 20ms after mount');
			assert(csM.animationName === 'pop-in', 'menu must animate pop-in, got ' + csM.animationName);
			assert(Math.abs(durMsOf(csM.animationDuration) - tPop) < 2, 'menu duration must follow --t-pop, got ' + durMsOf(csM.animationDuration));
			assert(csM.animationTimingFunction === 'cubic-bezier(0.2, 0.8, 0.2, 1)', 'menu timing must be --ease-out');
			assert(csM.animationFillMode === 'both', 'menu fill must be both');
			assert(tyOf(csM.transform) <= 0.5 && tyOf(csM.transform) >= -4.5, 'menu entrance slides down from above (translateY -4..0), got ' + csM.transform);
			step('menu-await-openP');
			await openP;
			assert(mm.el.querySelectorAll('button').length === 3, 'menu items must survive the animation wiring, buttons=' + mm.el.querySelectorAll('button').length);

			// ---- 4b. Esc closes it with pop-out + pointer-events none; clicks pass through underneath; gone within 200ms.
			var mr = mm.el.getBoundingClientRect();
			var mx = Math.round(mr.left + mr.width / 2);
			var my = Math.round(mr.top + mr.height / 2);
			var underM = document.createElement('button');
			underM.id = 'menu-under';
			underM.style.cssText = 'position:fixed;left:' + (mx - 20) + 'px;top:' + (my - 10) + 'px;width:40px;height:20px;z-index:1;';
			window.__menuClicks = 0;
			underM.addEventListener('click', function () { window.__menuClicks += 1; });
			document.body.append(underM);
			var hitMenu = document.elementFromPoint(mx, my);
			assert(hitMenu && mm.el.contains(hitMenu), 'open menu should cover the point under it');
			var mCloseT0 = performance.now();
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			var closingM = null;
			for (var p = 0; p < 20 && !closingM; p++) { closingM = document.querySelector('.local-file-menu.closing'); if (!closingM) await wait(5); }
			assert(closingM, 'Esc must leave the menu in .closing');
			var csMC = getComputedStyle(closingM);
			out.menuClosing = { name: csMC.animationName, durMs: durMsOf(csMC.animationDuration), pointerEvents: csMC.pointerEvents };
			assert(csMC.animationName === 'pop-out', 'closing menu must run pop-out, got ' + csMC.animationName);
			assert(Math.abs(durMsOf(csMC.animationDuration) - tClose) < 2, 'menu closing duration must follow --t-close');
			assert(csMC.pointerEvents === 'none', 'closing menu must not take clicks');
			var midHitM = document.elementFromPoint(mx, my);
			assert(midHitM && midHitM.id === 'menu-under', 'clicks must pass through the closing menu, hit ' + (midHitM ? midHitM.id || midHitM.className : 'null'));
			midHitM.click();
			assert(window.__menuClicks === 1, 'button under the closing menu must receive the click');
			var mRemovedMs = null;
			for (var q = 0; q < 60 && mRemovedMs === null; q++) {
				if (!document.contains(closingM)) mRemovedMs = Math.round(performance.now() - mCloseT0);
				else await wait(5);
			}
			out.menuRemovedMs = mRemovedMs;
			assert(mRemovedMs !== null && mRemovedMs <= 200, 'closing menu must be removed within 200ms, removed at ' + mRemovedMs);

			// ---- 5. Two right-clicks in a row: the old menu is dropped at once, never stacked.
			step('replace-open');
			await openMenu(60, 300);
			var firstMenu = document.querySelector('.local-file-menu:not(.closing)');
			assert(firstMenu, 'first of the pair missing');
			var second = openMenu(420, 300);
			assert(!document.contains(firstMenu), 'a replacing right-click must remove the old menu at once');
			var stacked = document.querySelectorAll('.local-file-menu');
			assert(stacked.length === 1, 'exactly one menu may exist while the replacement opens, got ' + stacked.length);
			await second;
			assert(document.querySelectorAll('.local-file-menu').length === 1, 'still exactly one menu after the second opened');
			// ---- 7b. The menu still closes on Esc (keyboard behavior unchanged).
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			for (var r2 = 0; r2 < 60 && document.querySelector('.local-file-menu'); r2++) await wait(5);
			assert(!document.querySelector('.local-file-menu'), 'Esc must dismiss the menu');

			// ---- 8. W207 contract: the window/document listeners the menu adds (plus the MutationObserver
			// watching document.body) exist only while the menu is open, detach with their exact handlers when
			// closing starts, and window blur / tab visibility only re-run the old poll's dead-anchor-or-slot-
			// switch check — a healthy menu survives both. getEventListeners is devtools-only, so the fixture
			// wraps addEventListener/removeEventListener and counts registrations instead.
			step('listener-audit');
			var live = [];
			var bodyMOs = [];
			var auditOn = true;
			var capOf = function (opts) { return opts === true || !!(opts && opts.capture); };
			var wrapTarget = function (obj, name) {
				var add = obj.addEventListener, remove = obj.removeEventListener;
				obj.addEventListener = function (type, handler, opts) {
					if (auditOn) live.push({ t: name, type: String(type), cap: capOf(opts), h: handler });
					return add.call(this, type, handler, opts);
				};
				obj.removeEventListener = function (type, handler, opts) {
					if (auditOn) {
						var cap = capOf(opts);
						for (var li = live.length - 1; li >= 0; li--) {
							if (live[li].t === name && live[li].type === String(type) && live[li].cap === cap && live[li].h === handler) { live.splice(li, 1); break; }
						}
					}
					return remove.call(this, type, handler, opts);
				};
			};
			var OrigMO = window.MutationObserver;
			window.MutationObserver = function (cb) {
				var inst = new OrigMO(cb);
				var obs = OrigMO.prototype.observe, dis = OrigMO.prototype.disconnect;
				inst.observe = function (node, opts) { if (auditOn && node === document.body) bodyMOs.push(inst); return obs.call(inst, node, opts); };
				inst.disconnect = function () { var mi = bodyMOs.indexOf(inst); if (mi >= 0) bodyMOs.splice(mi, 1); return dis.call(inst); };
				return inst;
			};
			wrapTarget(window, 'window');
			wrapTarget(document, 'document');
			var keyCount = function (t, type, cap) { var n = 0; for (var ki = 0; ki < live.length; ki++) { if (live[ki].t === t && live[ki].type === type && live[ki].cap === cap) n += 1; } return n; };
			var auditSnapshot = function () {
				return {
					tracked: live.length, bodyObservers: bodyMOs.length,
					blur: keyCount('window', 'blur', false), focus: keyCount('window', 'focus', false),
					visibilitychange: keyCount('document', 'visibilitychange', false),
					keydownCapture: keyCount('window', 'keydown', true), scrollCapture: keyCount('window', 'scroll', true),
					resize: keyCount('window', 'resize', false), pointerdownCapture: keyCount('document', 'pointerdown', true),
					menus: document.querySelectorAll('.local-file-menu').length,
				};
			};
			var menuUp = function () { return !!document.querySelector('.local-file-menu:not(.closing)'); };
			var auditWait = async function (predicate, ms) { var rounds = Math.max(1, Math.ceil(ms / 5)); for (var ai = 0; ai < rounds && !predicate(); ai++) await wait(5); return predicate(); };
			var auditKeys = ['blur', 'focus', 'visibilitychange', 'keydownCapture', 'scrollCapture', 'resize', 'pointerdownCapture'];
			var auditBase = auditSnapshot();
			out.listenerAudit = { baseline: auditBase };
			assert(auditBase.tracked === 0 && auditBase.bodyObservers === 0 && auditBase.menus === 0, 'audit must start with nothing tracked: ' + JSON.stringify(auditBase));
			await openMenu(100, 320);
			var auditOpen = auditSnapshot();
			out.listenerAudit.open = auditOpen;
			assert(auditOpen.menus === 1 && auditOpen.tracked === auditKeys.length && auditOpen.bodyObservers === 1, 'open menu must hold exactly its ' + auditKeys.length + ' listeners plus one body observer: ' + JSON.stringify(auditOpen));
			for (var ak = 0; ak < auditKeys.length; ak++) assert(auditOpen[auditKeys[ak]] === 1, 'open menu must hold ' + auditKeys[ak] + ': ' + JSON.stringify(auditOpen));
			window.dispatchEvent(new Event('blur'));
			await wait(120);
			assert(menuUp() && !document.querySelector('.local-file-menu.closing'), 'a plain window blur keeps a healthy menu open (the 200ms poll never dismissed on blur): ' + JSON.stringify(auditSnapshot()));
			var realVisibility = document.visibilityState;
			var fakeVisibility = null;
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return fakeVisibility === null ? realVisibility : fakeVisibility; } });
			fakeVisibility = 'hidden';
			document.dispatchEvent(new Event('visibilitychange'));
			await wait(120);
			assert(menuUp(), 'a hidden tab with the anchor alive keeps the menu open: ' + JSON.stringify(auditSnapshot()));
			fakeVisibility = null;
			document.dispatchEvent(new Event('visibilitychange'));
			await wait(80);
			assert(menuUp(), 'coming back to a tab whose menu saw no checked-condition change keeps it open: ' + JSON.stringify(auditSnapshot()));
			target.remove();
			var auditGone = await auditWait(function () { return !document.querySelector('.local-file-menu'); }, 900);
			var auditAfterGone = auditSnapshot();
			out.listenerAudit.afterAnchorGone = auditAfterGone;
			assert(auditGone, 'a menu whose anchor left the DOM must dismiss with no focus event at all (old poll did it within 200ms; now the body observer does): ' + JSON.stringify(auditAfterGone));
			assert(auditAfterGone.tracked === 0 && auditAfterGone.bodyObservers === 0, 'dismissal must detach every tracked listener and the body observer: ' + JSON.stringify(auditAfterGone));
			document.body.append(target);
			await openMenu(140, 320);
			var auditReopen = auditSnapshot();
			out.listenerAudit.reopen = auditReopen;
			assert(auditReopen.menus === 1 && auditReopen.tracked === auditKeys.length && auditReopen.bodyObservers === 1, 'reopening re-attaches the same budget: ' + JSON.stringify(auditReopen));
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			var auditEscClosed = await auditWait(function () { return !document.querySelector('.local-file-menu'); }, 900);
			var auditAfterEsc = auditSnapshot();
			out.listenerAudit.afterEsc = auditAfterEsc;
			assert(auditEscClosed && auditAfterEsc.tracked === 0 && auditAfterEsc.bodyObservers === 0 && auditAfterEsc.menus === 0, 'Esc close leaves no listener behind: ' + JSON.stringify(auditAfterEsc));
			auditOn = false;
			clearTimeout(window.__wd);
			window.__done = 1;
			document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed ' + JSON.stringify(out) + '</p>');
		} catch (err) {
			clearTimeout(window.__wd);
			window.__pfail(' ' + err.message + ' ' + JSON.stringify(out));
		}
	})();
}
`;

function serveFixture(root: string) {
	const server = new WebHttpServer();
	for (const dir of ["js", "vendor", "css"]) {
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
	}
	server.mount({ prefix: "/test/", directory: root });
	server.route("GET", "/api/workspaces", () => ({ workspaces: [] }));
	server.route("GET", "/api/sessions/unbound", () => ({ sessions: [] }));
	server.route("GET", "/api/sessions/archived", () => ({ sessions: [] }));
	server.route("GET", "/api/slots", () => ({ slots: [] }));
	server.route("GET", "/api/state", () => ({
		items: [],
		session: { id: "w143", file: "C:/fixture/w143.jsonl" },
		app: {},
		flags: {},
		thinking: {},
		trust: { trusted: true },
		surface: { widgets: {}, statuses: {} },
		queue: { steering: [], followUp: [] },
		run: {},
	}));
	server.route("GET", "/api/resources", () => ({
		commands: [],
		contextFiles: [],
		tools: [],
		skills: [],
		templates: [],
		extensions: [],
	}));
	server.route("GET", "/api/git/status", () => ({}));
	server.route("GET", "/api/models", () => ({ models: [] }));
	server.route("GET", "/api/files/search", () => ({ files: ["src/alpha.ts", "src/beta.ts"] }));
	server.route("POST", "/api/seen", () => ({ ok: true }));
	server.route("POST", "/api/sessions/open", () => ({ slot: null, created: false }));
	server.route("POST", "/api/files/local", (ctx) => {
		const body = ctx.body as { action?: string; path?: string };
		if (body.action === "choices")
			return { path: String(body.path), directory: false, choices: [{ id: "editor-1", label: "Test Editor" }] };
		return { path: String(body.path) };
	});
	writeFileSync(join(root, "index.html"), indexHtml);
	writeFileSync(join(root, "test.js"), testJs);
	writeFileSync(join(root, "sink.js"), sinkJs);
	server.setIndexFile(join(root, "index.html"));
	return server;
}

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"suggest list and local-file menu animate with pop-in/pop-out, never stack and never block clicks",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-suggest-localfile-motion-"));
		const server = serveFixture(root);
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Suggest and local-file motion test",
				isSolved: (candidate) => candidate.text.includes('id="ready">'),
			});
			expect(page.text).toContain('id="ready">passed');
			// Evidence for the W207 acceptance: print the listener-count snapshots taken inside the page.
			const passedAt = page.text.indexOf("passed {");
			expect(passedAt, "the ready marker must carry the JSON outcome").toBeGreaterThanOrEqual(0);
			const jsonText = page.text.slice(passedAt + "passed ".length);
			const auditJson = jsonText.slice(0, jsonText.lastIndexOf("}") + 1);
			let listenerAudit: unknown = "<unparsed>";
			try {
				listenerAudit = (JSON.parse(auditJson) as { listenerAudit?: unknown }).listenerAudit;
			} catch {
				/* keep the placeholder; the in-page assertions already guarded the run */
			}
			console.log(`W207 listener audit: ${JSON.stringify(listenerAudit)}`);
			// vitest.config sets silent:"passed-only", so also drop the snapshot as an artifact for the W207 receipt.
			if (process.env.MYHARNESS_ARTIFACTS_DIR) {
				mkdirSync(process.env.MYHARNESS_ARTIFACTS_DIR, { recursive: true });
				writeFileSync(
					join(process.env.MYHARNESS_ARTIFACTS_DIR, "W207-listener-audit.json"),
					JSON.stringify(listenerAudit, null, "\t"),
				);
			}
		} finally {
			await browser.shutdown();
			await server.close();
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
		}
	},
	120000,
);

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"reduced motion keeps both lists to a short fade with no slide",
	async () => {
		const root = mkdtempSync(
			join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-suggest-localfile-reduced-"),
		);
		const server = serveFixture(root);
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
			expect(value.error, `both fixtures must mount under reduced motion: ${String(value.error)}`).toBeUndefined();
			expect(value.reduced, "matchMedia must report the emulated reduce").toBe(true);
			for (const part of ["suggest", "menu"]) {
				expect(value[part].name, `${part} keeps the pop-in name`).toBe("pop-in");
				expect(value[part].durMs, `${part} duration must collapse under reduced motion`).toBeLessThanOrEqual(60);
				expect(value[part].opacity, `${part} must be fully visible once the short fade is through`).toBe("1");
				expect(
					value[part].transform === "none" || /matrix\(1, 0, 0, 1, 0, 0\)/u.test(String(value[part].transform)),
					`${part} must show no slide under reduced motion, transform=${value[part].transform}`,
				).toBe(true);
			}
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
	120000,
);
