import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The W141 self-drawn Select (web/js/select.js): a `.select-like` combobox trigger that looks like `.select`
// (32 px / 28 px, shared --chev-img chevron that turns 180 degrees while open), the shared ui.js Popover for the
// panel (so it inherits the W140 pop-in / pop-out motion), `.pop-item` options with aria-selected and a check on the
// current row, full keyboard support (Enter/Space/arrows to open, arrows that skip disabled rows, Home/End,
// Enter/Space pick, Esc/Tab close with focus kept on the trigger, 800 ms type-ahead), a 420 px wrap-safe panel with
// a 280 px scroll area, group heads, and flip/clamp near the viewport edges. The first case runs the whole battery
// against the real component; the second one resizes the viewport (CDP device metrics) to prove a narrow screen.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>';

const testJs = `
import { h, render } from '/vendor/preact.js';
import { useState } from '/vendor/preact-hooks.js';
import { Select } from '/js/select.js';

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var assert = function (ok, msg) { if (!ok) throw Error(msg); };
var adOf = function (el) { return el.getAttribute('aria-activedescendant'); };
var key = async function (el, k) { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await wait(20); };
var durMsOf = function (duration) {
	var n = parseFloat(duration);
	return duration.indexOf('ms') >= 0 ? n : n * 1000;
};
var findPop = async function (sel) {
	for (var i = 0; i < 150; i++) {
		var p = document.querySelector(sel);
		if (p) return { pop: p, mountedAt: performance.now() };
		await wait(2);
	}
	return null;
};
var clickF = function (el) { el.focus(); el.click(); };
var gone = async function (el) {
	for (var i = 0; i < 80; i++) {
		if (!document.contains(el)) return true;
		await wait(5);
	}
	return false;
};

var FRUIT = [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Banana' }, { value: 'c', label: 'Cherry' }];
var SKIPS = [
	{ value: '1', label: 'One', group: 'Low' },
	{ value: '2', label: 'Two', group: 'Low', disabled: true },
	{ value: '3', label: 'Three', group: 'High' },
	{ value: '4', label: 'Four', group: 'High', disabled: true },
	{ value: '5', label: 'Five', hint: 'last one' },
];
var LONG_LABEL = 'provider-with-a-very-long-identifier/' + 'superlongmodelidentifier-'.repeat(6) + 'tail';
var LONGS = [{ value: 'short', label: 'Short' }, { value: 'long', label: LONG_LABEL, hint: 'a hint that is also quite long' }];
var MANY = [];
for (var mi = 0; mi < 30; mi++) MANY.push({ value: 'o' + mi, label: 'Option number ' + mi });
var SMS = [{ value: 's1', label: 'A longer compact option label' }];
var NRS = [{ value: 'n1', label: 'Narrow fit' }, { value: 'n2', label: 'x'.repeat(200) }];
var NBS = [{ value: 'b1', label: 'One' }, { value: 'b2', label: 'Two' }, { value: 'b3', label: 'Three' }, { value: 'b4', label: 'Four' }, { value: 'b5', label: 'Five' }, { value: 'b6', label: 'Six' }];

var state = { a: 'b', skips: '', long: 'long', many: 'o5', sm: 's1', off: 'y1', nr: 'n1', nb: 'b3' };
window.__changes = [];
window.__clicks = 0;
window.__set = null;

function card(id, x, y, props, boxStyle) {
	return h('div', { key: id, style: Object.assign({ position: 'absolute', left: x + 'px', top: y + 'px' }, boxStyle || {}) },
		h(Select, Object.assign({ id: id, ariaLabel: id }, props)));
}

function App() {
	var pair = useState(0);
	window.__set = function (k, v) { state[k] = v; pair[1](pair[0] + 1); };
	return h('div', {},
		h('select', { id: 'ref-select', class: 'select', tabIndex: -1, style: { position: 'fixed', left: '-2000px', top: '0' } },
			h('option', { value: 'a' }, 'Apple')),
		h('button', { id: 'under-btn', style: { position: 'fixed', left: '50px', top: '108px', width: '80px', height: '20px' }, onClick: function () { window.__clicks += 1; } }, 'Under'),
		card('sel-a', 40, 24, { value: state.a, options: FRUIT, onChange: function (v) { window.__changes.push(['a', v]); window.__set('a', v); } }),
		card('sel-skips', 300, 24, { value: state.skips, options: SKIPS, onChange: function (v) { window.__changes.push(['skips', v]); window.__set('skips', v); } }),
		card('sel-many', 700, 24, { value: state.many, options: MANY, onChange: function (v) { window.__changes.push(['many', v]); window.__set('many', v); } }),
		card('sel-sm', 1000, 24, { value: state.sm, options: SMS, size: 'sm', onChange: function (v) { window.__changes.push(['sm', v]); window.__set('sm', v); } }, { width: '150px' }),
		card('sel-long', 40, 520, { value: state.long, options: LONGS, onChange: function (v) { window.__changes.push(['long', v]); window.__set('long', v); } }),
		card('sel-off', 560, 520, { value: 'y1', options: [{ value: 'y1', label: 'Nope' }], disabled: true, onChange: function () { window.__changes.push(['off', 'x']); } }));
}

function NarrowApp() {
	return h('div', {},
		h('div', { style: { position: 'fixed', right: '8px', top: '40px', width: '240px' } },
			h(Select, { id: 'nr', ariaLabel: 'Narrow', value: state.nr, options: NRS, fitContent: false, onChange: function (v) { window.__set('nr', v); } })),
		h('div', { style: { position: 'fixed', left: '8px', top: '470px' } },
			h(Select, { id: 'nb', ariaLabel: 'Bottom', value: state.nb, options: NBS, onChange: function (v) { window.__set('nb', v); } })));
}

window.__narrowCheck = async function () {
	var out = { vw: window.innerWidth, vh: window.innerHeight };
	var nr = document.getElementById('nr');
	nr.click();
	var f = await findPop('.popover.select-pop:not(.closing)');
	if (!f) return JSON.stringify({ error: 'narrow-right panel never opened' });
	var name = getComputedStyle(f.pop).animationName;
	await wait(300);
	var r = f.pop.getBoundingClientRect();
	var tr = nr.getBoundingClientRect();
	out.right = { name: name, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), trigLeft: Math.round(tr.left), trigWidth: Math.round(tr.width) };
await key(nr, 'Escape');
	if (!(await gone(f.pop))) return JSON.stringify({ error: 'narrow-right panel never removed', out: out });
	var nb = document.getElementById('nb');
	nb.click();
	var f2 = await findPop('.popover.select-pop:not(.closing)');
	if (!f2) return JSON.stringify({ error: 'bottom panel never opened', out: out });
	var cs2 = getComputedStyle(f2.pop);
	await wait(300);
	var r2 = f2.pop.getBoundingClientRect();
	var t2 = nb.getBoundingClientRect();
	out.bottom = {
		name: cs2.animationName,
		placement: f2.pop.getAttribute('data-placement'),
		shift: parseFloat(cs2.getPropertyValue('--pop-shift')),
		top: Math.round(r2.top), bottom: Math.round(r2.bottom),
		trigTop: Math.round(t2.top), trigBottom: Math.round(t2.bottom),
	};
await key(nb, 'Escape');
	return JSON.stringify(out);
};

render(h(location.search.indexOf('mode=narrow') >= 0 ? NarrowApp : App, {}), document.getElementById('app'));

if (location.search.indexOf('mode=narrow') < 0) {
	(async function () {
		var out = {};
		try {
			// The color tokens sit under :root[data-theme=...]; the app sets it at boot, the fixture picks dark.
			document.documentElement.dataset.theme = 'dark';
			await wait(200);
			var root = getComputedStyle(document.documentElement);
			var tPop = parseFloat(root.getPropertyValue('--t-pop'));
			var tClose = parseFloat(root.getPropertyValue('--t-close'));
			var disOp = parseFloat(root.getPropertyValue('--disabled-opacity'));
			assert(tPop >= 140 && tPop <= 180, '--t-pop must be 140-180ms, got ' + tPop);
			assert(tClose >= 100 && tClose <= 120, '--t-close must be 100-120ms, got ' + tClose);
			assert(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'host has reduced motion on; the full-motion run needs it off');
			assert(document.documentElement.dataset.motion !== 'off', 'data-motion must not be off for the motion checks');

			var sa = document.getElementById('sel-a');
			var sm = document.getElementById('sel-sm');
			var ref = document.getElementById('ref-select');
			var under = document.getElementById('under-btn');
			var ur = under.getBoundingClientRect();
			var cx = Math.round(ur.left + ur.width / 2);
			var cy = Math.round(ur.top + ur.height / 2);

			// 1. The trigger looks like the native .select: one height pair, same colors, room for the shared chevron.
			var csA = getComputedStyle(sa);
			var csRef = getComputedStyle(ref);
			out.trigger = {
				h: sa.getBoundingClientRect().height, hSm: sm.getBoundingClientRect().height,
				radius: csA.borderRadius, bg: csA.backgroundColor, border: csA.borderTopColor,
				paddingRight: csA.paddingRight,
			};
			assert(Math.abs(out.trigger.h - 32) < 0.6, 'md trigger must be 32 px tall, got ' + out.trigger.h);
			assert(Math.abs(out.trigger.hSm - 28) < 0.6, 'sm trigger must be 28 px tall, got ' + out.trigger.hSm);
			assert(parseFloat(csA.borderRadius) === parseFloat(root.getPropertyValue('--r-md')), 'radius must follow --r-md, got ' + csA.borderRadius);
			assert(csA.backgroundColor === csRef.backgroundColor, 'background must match .select: ' + csA.backgroundColor + ' vs ' + csRef.backgroundColor);
			assert(csA.borderTopColor === csRef.borderTopColor, 'border must match .select: ' + csA.borderTopColor + ' vs ' + csRef.borderTopColor);
			assert(parseFloat(csA.paddingRight) >= 30, 'chevron room at the right edge: ' + csA.paddingRight);
			var chevA = getComputedStyle(sa, '::after');
			assert(/url\\(/.test(csRef.backgroundImage), 'native .select chevron image missing');
			assert(chevA.backgroundImage === csRef.backgroundImage, 'trigger chevron must reuse --chev-img exactly');
			assert(parseFloat(chevA.width) === 12 && parseFloat(chevA.height) === 12, 'chevron must be 12 px, got ' + chevA.width + '/' + chevA.height);
			assert(parseFloat(chevA.right) === 10, 'chevron must sit 10 px from the right edge, got ' + chevA.right);
			assert(chevA.transform === 'none', 'closed chevron must not be rotated, got ' + chevA.transform);

			// 2. Closed aria contract.
			assert(sa.getAttribute('role') === 'combobox', 'trigger role=combobox');
			assert(sa.getAttribute('aria-haspopup') === 'listbox', 'aria-haspopup=listbox');
			assert(sa.getAttribute('aria-expanded') === 'false', 'aria-expanded false while closed');
			assert(sa.getAttribute('aria-controls') === 'sel-a-list', 'aria-controls points at the listbox id');
			assert(!sa.hasAttribute('aria-activedescendant'), 'activedescendant only while open');
			assert(sa.title === 'Banana', 'trigger title carries the full label, got ' + sa.title);
			assert(sa.textContent.trim() === 'Banana', 'controlled label shows the current value');

			// 3. Open by click: the inherited W140 motion, panel sizing, and the option aria tree.
			clickF(sa);
			var f = await findPop('.popover.select-pop:not(.closing)');
			assert(f, 'click never opened the panel');
			var csP = getComputedStyle(f.pop);
			var pr = f.pop.getBoundingClientRect();
			out.open = {
				name: csP.animationName, durMs: durMsOf(csP.animationDuration), timing: csP.animationTimingFunction,
				fill: csP.animationFillMode, placement: f.pop.getAttribute('data-placement'), width: Math.round(pr.width),
			};
			assert(csP.animationName === 'pop-in', 'Select panel must inherit pop-in, got ' + csP.animationName);
			assert(Math.abs(durMsOf(csP.animationDuration) - tPop) < 2, 'open duration must follow --t-pop, got ' + durMsOf(csP.animationDuration));
			assert(csP.animationTimingFunction === 'cubic-bezier(0.2, 0.8, 0.2, 1)', 'timing must be --ease-out, got ' + csP.animationTimingFunction);
			assert(csP.animationFillMode === 'both', 'fill must be both, got ' + csP.animationFillMode);
			assert(f.pop.getAttribute('data-placement') === 'bottom', 'data-placement bottom, got ' + f.pop.getAttribute('data-placement'));
			assert(pr.width >= sa.getBoundingClientRect().width - 0.5, 'panel is never narrower than the trigger: ' + pr.width);
			assert(pr.width <= Math.min(420, window.innerWidth - 16) + 0.5, 'panel clamps to min(420 px, vw-16): ' + pr.width);
			assert(sa.getAttribute('aria-expanded') === 'true', 'aria-expanded true while open');
			var lb = document.getElementById('sel-a-list');
			assert(lb && lb.getAttribute('role') === 'listbox', 'role=listbox on the panel list');
			var opts = [];
			var kids = lb.children;
			for (var oi = 0; oi < kids.length; oi++) if (kids[oi].getAttribute('role') === 'option') opts.push(kids[oi]);
			assert(opts.length === 3, 'three options, got ' + opts.length);
			assert(adOf(sa) === 'sel-a-list-o1', 'open starts the highlight on the current value, got ' + adOf(sa));
			assert(opts[1].getAttribute('aria-selected') === 'true' && opts[0].getAttribute('aria-selected') === 'false', 'aria-selected marks only the current value');
			assert(opts[1].querySelector('svg'), 'the current row shows the check icon');
			assert(!opts[0].querySelector('svg') && !opts[2].querySelector('svg'), 'no check on the other rows');
			assert(opts[1].className.indexOf('active') >= 0, 'current row keeps the .pop-item.active look');
			assert(document.activeElement === sa, 'focus stays on the trigger while the highlight is virtual');
			assert(adOf(sa) === opts[1].id, 'activedescendant points at the highlighted row');
			// Focus ring: the same border color .field:focus takes. The ring and the chevron both turn over --t-fast
			// (90 ms) and headless focus settles on its own schedule: poll each until it arrives.
			var probe = document.createElement('span');
			probe.style.color = 'var(--border-focus)';
			document.body.appendChild(probe);
			var want = getComputedStyle(probe).color;
			document.body.removeChild(probe);
			var fT0 = performance.now();
			var focusOk = false;
			for (var fi = 0; fi < 80 && !focusOk; fi++) {
				focusOk = getComputedStyle(sa).borderTopColor === want;
				if (!focusOk) await wait(10);
			}
			assert(focusOk, 'focus border must reach --border-focus (' + want + '), stuck at ' + getComputedStyle(sa).borderTopColor);
			out.focusRing = { color: want, settledMs: Math.round(performance.now() - fT0) };
			var chevOpen = '';
			var rotOk = false;
			for (var ci = 0; ci < 80 && !rotOk; ci++) {
				chevOpen = getComputedStyle(sa, '::after').transform;
				rotOk = /matrix\\(-1, 0, 0, -1, 0, 0\\)/.test(chevOpen);
				if (!rotOk) await wait(10);
			}
			assert(rotOk, 'open chevron must turn 180 degrees, last value ' + chevOpen);
			// An open panel does cover the button underneath (it only stops taking clicks while closing).
			var hitOpen = document.elementFromPoint(cx, cy);
			assert(hitOpen && f.pop.contains(hitOpen), 'open panel should cover the under button, hit ' + (hitOpen ? hitOpen.id || hitOpen.className : 'null'));

			// 4. Keyboard: arrows wrap and move the highlight, Home/End, type-ahead with an 800 ms buffer, Enter picks.
		await key(sa, 'ArrowDown');
			assert(adOf(sa) === 'sel-a-list-o2', 'ArrowDown 1->2, got ' + adOf(sa));
			assert(opts[2].className.indexOf('hi') >= 0 && opts[1].className.indexOf('hi') < 0, 'the .hi class follows the highlight');
		await key(sa, 'ArrowDown');
			assert(adOf(sa) === 'sel-a-list-o0', 'ArrowDown wraps past the end, got ' + adOf(sa));
		await key(sa, 'End');
			assert(adOf(sa) === 'sel-a-list-o2', 'End -> last enabled, got ' + adOf(sa));
		await key(sa, 'Home');
			assert(adOf(sa) === 'sel-a-list-o0', 'Home -> first, got ' + adOf(sa));
		await key(sa, 'c');
			assert(adOf(sa) === 'sel-a-list-o2', 'type c -> Cherry, got ' + adOf(sa));
		await key(sa, 'h');
			assert(adOf(sa) === 'sel-a-list-o2', 'type-ahead keeps the 800 ms prefix buffer (ch)');
			await wait(860);
		await key(sa, 'a');
			assert(adOf(sa) === 'sel-a-list-o0', 'after 800 ms the buffer restarts with a fresh letter');
			var chBefore = window.__changes.length;
		await key(sa, 'Enter');
			assert(sa.getAttribute('aria-expanded') === 'false', 'Enter picks and closes');
			assert(await gone(f.pop), 'panel removed after Enter');
			assert(window.__changes.length === chBefore + 1 && window.__changes[chBefore][1] === 'a', 'onChange fired with the new value: ' + JSON.stringify(window.__changes));
			assert(sa.textContent.trim() === 'Apple' && sa.title === 'Apple', 'the controlled value drives the label');
			assert(document.activeElement === sa, 'after a pick the keyboard is back on the trigger');
			out.pick = { value: 'a', title: sa.title };

			// 5. Space opens and picks; picking the current value does not fire onChange.
			var ch2 = window.__changes.length;
		await key(sa, ' ');
			assert(sa.getAttribute('aria-expanded') === 'true', 'Space opens');
			var f2 = await findPop('.popover.select-pop:not(.closing)');
			assert(f2, 'Space opened no panel');
		await key(sa, ' ');
			assert(sa.getAttribute('aria-expanded') === 'false', 'Space picks the highlight and closes');
			assert(await gone(f2.pop), 'panel removed after Space pick');
			assert(window.__changes.length === ch2, 'picking the unchanged value must not fire onChange');

			// 6. Esc closes with focus kept on the trigger; the closing panel runs pop-out, takes no clicks, dies fast.
			clickF(sa);
			var f3 = await findPop('.popover.select-pop:not(.closing)');
			assert(f3, 're-open after Space failed');
			var t0 = performance.now();
		await key(sa, 'Escape');
			assert(sa.getAttribute('aria-expanded') === 'false', 'Esc closes');
			await wait(10);
			var closing = document.querySelector('.popover.select-pop.closing');
			assert(closing, 'the closing class must appear');
			var csC = getComputedStyle(closing);
			out.closing = { name: csC.animationName, durMs: durMsOf(csC.animationDuration), pointerEvents: csC.pointerEvents };
			assert(csC.animationName === 'pop-out', 'closing must run pop-out, got ' + csC.animationName);
			assert(Math.abs(durMsOf(csC.animationDuration) - tClose) < 2, 'closing duration must follow --t-close, got ' + durMsOf(csC.animationDuration));
			assert(csC.pointerEvents === 'none', 'the closing panel must not take clicks, got ' + csC.pointerEvents);
			assert(document.activeElement === sa, 'Esc keeps the keyboard on the trigger');
			// Mid-close the click passes through to the button under the still-visible panel.
			var underHit = null;
			var hits = [];
			while (performance.now() - t0 < 95 && !underHit) {
				var h2 = document.elementFromPoint(cx, cy);
				hits.push(Math.round(performance.now() - t0) + ':' + (h2 ? h2.id || h2.className : 'null'));
				if (h2 && h2.id === 'under-btn') underHit = h2;
				else await wait(5);
			}
			assert(underHit, 'clicks must pass through the closing panel, samples=' + hits.join(','));
			assert(document.contains(closing), 'the closing panel should still be mounted mid-animation');
			var clicksBefore = window.__clicks;
			underHit.click();
			assert(window.__clicks === clicksBefore + 1, 'the button under the closing panel must receive the click');
			var removed = await gone(f3.pop);
			out.closing.removedMs = Math.round(performance.now() - t0);
			assert(removed && out.closing.removedMs <= 220, 'closing panel must be gone within 220 ms, removed at ' + out.closing.removedMs);

			// 7. Tab closes; a mousedown outside closes (useClickOutside through Popover).
			clickF(sa);
			var f4 = await findPop('.popover.select-pop:not(.closing)');
			assert(f4, 're-open for Tab failed');
		await key(sa, 'Tab');
			assert(sa.getAttribute('aria-expanded') === 'false', 'Tab closes the list');
			assert(await gone(f4.pop), 'panel removed after Tab');
			clickF(sa);
			var f5 = await findPop('.popover.select-pop:not(.closing)');
			assert(f5, 're-open for outside click failed');
			document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 }));
			await wait(20);
			assert(sa.getAttribute('aria-expanded') === 'false', 'a mousedown outside closes the list');
			assert(await gone(f5.pop), 'panel removed after outside click');

			// 8. A value the parent sets from outside re-renders the label (the component stays controlled).
			window.__set('a', 'c');
			await wait(30);
			assert(sa.textContent.trim() === 'Cherry', 'controlled value drives the label from outside');

			// 9. Disabled rows: skipped by arrows and type-ahead, aria-disabled, --disabled-opacity, no check.
			var sk = document.getElementById('sel-skips');
			clickF(sk);
			var fs = await findPop('.popover.select-pop:not(.closing)');
			assert(fs, 'skips panel never opened');
			var lbS = document.getElementById('sel-skips-list');
			var heads = lbS.querySelectorAll('.pop-head');
			assert(heads.length === 2 && heads[0].textContent === 'Low' && heads[1].textContent === 'High', 'two group heads with .pop-head, got ' + heads.length);
			var oS = [];
			var kidsS = lbS.children;
			for (var si = 0; si < kidsS.length; si++) if (kidsS[si].getAttribute('role') === 'option') oS.push(kidsS[si]);
			assert(oS.length === 5, 'five options, got ' + oS.length);
			assert(oS[1].disabled === true && oS[1].getAttribute('aria-disabled') === 'true', 'disabled row: real disabled + aria-disabled');
			assert(Math.abs(parseFloat(getComputedStyle(oS[1]).opacity) - disOp) < 0.01, 'disabled row uses --disabled-opacity, got ' + getComputedStyle(oS[1]).opacity);
			assert(!!oS[4].querySelector('.select-opt-hint'), 'the hint cell renders');
			assert(adOf(sk) === 'sel-skips-list-o0', 'no value: the highlight starts on the first enabled row, got ' + adOf(sk));
		await key(sk, 'ArrowDown');
			assert(adOf(sk) === 'sel-skips-list-o2', 'ArrowDown must skip the disabled row, got ' + adOf(sk));
		await key(sk, 'ArrowUp');
			assert(adOf(sk) === 'sel-skips-list-o0', 'ArrowUp must skip back over it, got ' + adOf(sk));
		await key(sk, 'End');
			assert(adOf(sk) === 'sel-skips-list-o4', 'End -> last enabled, got ' + adOf(sk));
		await key(sk, 'Home');
		await key(sk, 'f');
			assert(adOf(sk) === 'sel-skips-list-o4', 'type-ahead must not stop on the disabled Four, got ' + adOf(sk));
			out.skips = { heads: heads.length, afterDown: adOf(sk) };
		await key(sk, 'Escape');
			assert(await gone(fs.pop), 'skips panel removed');

			// 10. A long label wraps inside the panel instead of pushing it wider; the full text stays in title.
			var lg = document.getElementById('sel-long');
			clickF(lg);
			var fl = await findPop('.popover.select-pop:not(.closing)');
			assert(fl, 'long panel never opened');
			var lr = fl.pop.getBoundingClientRect();
			assert(lr.width <= Math.min(420, window.innerWidth - 16) + 0.5, 'long text clamps the panel to min(420 px, vw-16): ' + lr.width);
			var lbL = document.getElementById('sel-long-list');
			assert(lbL.scrollWidth <= lbL.clientWidth + 1, 'no horizontal overflow inside the list: ' + lbL.scrollWidth + ' vs ' + lbL.clientWidth);
			var longRow = document.getElementById('sel-long-list-o1');
			assert(longRow.title === LONG_LABEL, 'the full id lives in title');
			assert(longRow.getBoundingClientRect().height >= 38, 'the long row wrapped onto several lines, height ' + longRow.getBoundingClientRect().height);
			assert(!!longRow.querySelector('.select-opt-hint'), 'hint kept beside the wrapped label');
			out.long = { popWidth: Math.round(lr.width), rowHeight: Math.round(longRow.getBoundingClientRect().height) };
		await key(lg, 'Escape');
			assert(await gone(fl.pop), 'long panel removed');

			// 11. Long lists scroll inside 280 px, and the keyboard highlight stays in view.
			var mn = document.getElementById('sel-many');
			clickF(mn);
			var fm = await findPop('.popover.select-pop:not(.closing)');
			assert(fm, 'many panel never opened');
			var lbM = document.getElementById('sel-many-list');
			var csM = getComputedStyle(lbM);
			out.many = { maxHeight: csM.maxHeight, clientHeight: lbM.clientHeight, scrollHeight: lbM.scrollHeight };
			assert(parseFloat(csM.maxHeight) === 280, 'the option area caps at 280 px, got ' + csM.maxHeight);
			assert(lbM.clientHeight <= 280.5 && lbM.scrollHeight > lbM.clientHeight + 10, '30 rows really scroll inside the 280 px box');
		await key(mn, 'End');
			await wait(40);
			assert(adOf(mn) === 'sel-many-list-o29', 'End -> row 29, got ' + adOf(mn));
			assert(lbM.scrollTop > 50, 'the highlighted row was scrolled into view, scrollTop=' + lbM.scrollTop);
		await key(mn, 'Escape');
			assert(await gone(fm.pop), 'many panel removed');

			// 12. In a narrow box the trigger shrinks to the box and the value ellipsises (title keeps the full text).
			var smSpan = sm.querySelector('.select-value');
			assert(smSpan.scrollWidth > smSpan.clientWidth + 1, 'the long sm value truncates with an ellipsis');
			assert(sm.title === SMS[0].label, 'sm title still carries the full label');
			assert(sm.getBoundingClientRect().width <= 150.5, 'the trigger never exceeds its 150 px box');

			// 13. A disabled trigger never opens.
			var off = document.getElementById('sel-off');
			off.click();
			assert(off.getAttribute('aria-expanded') === 'false', 'a disabled trigger ignores clicks');
			assert(!document.querySelector('.popover.select-pop:not(.closing)'), 'a disabled trigger opens nothing');
			assert(off.disabled === true && off.getAttribute('aria-disabled') === 'true', 'disabled trigger: real disabled + aria-disabled');
			assert(Math.abs(parseFloat(getComputedStyle(off).opacity) - disOp) < 0.01, 'disabled trigger uses --disabled-opacity');

			out.ok = true;
			document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed ' + JSON.stringify(out) + '</p>');
		} catch (err) {
			document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + ' ' + JSON.stringify(out) + '</p>');
		}
	})();
} else {
	document.documentElement.dataset.theme = 'dark';
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">narrow-ready</p>');
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
	"Select opens, closes, picks; keyboard, aria, motion and wrapping all hold",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-select-component-"));
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
				label: "Select component test",
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
	"a narrow viewport keeps the panel on screen (clamped) and flips it above the trigger at the bottom",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-select-narrow-"));
		const server = servePage(root);
		const chosen =
			installed.find((entry) => entry.kind === "chrome") ?? installed.find((entry) => entry.kind === "edge");
		expect(chosen, "this case needs Chrome or Edge for Emulation.setDeviceMetricsOverride").toBeDefined();
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
			const created = await bridge.send("Target.createTarget", { url: `http://127.0.0.1:${port}/?mode=narrow` });
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
						{ expression: "String(!!window.__narrowCheck)", returnByValue: true },
						sessionId,
					)
					.catch((): Record<string, unknown> => ({}));
				ready = (reply.result as { value?: string } | undefined)?.value === "true";
				if (!ready) await new Promise((r) => setTimeout(r, 200));
			}
			expect(ready, "the narrow fixture page never came up").toBe(true);
			await bridge.send(
				"Emulation.setDeviceMetricsOverride",
				{ width: 380, height: 520, deviceScaleFactor: 1, mobile: false },
				sessionId,
			);
			await new Promise((r) => setTimeout(r, 400));
			const evaluated = await bridge.send(
				"Runtime.evaluate",
				{ expression: "window.__narrowCheck()", awaitPromise: true, returnByValue: true },
				sessionId,
			);
			const value = JSON.parse(String((evaluated.result as { value?: string } | undefined)?.value ?? "{}"));
			expect(value.error, `narrow checks must run: ${String(value.error)}`).toBeUndefined();
			expect(value.vw, "the emulated viewport must be 380 px wide").toBe(380);
			// Right edge: the panel stays fully on screen and is clamped to the viewport, never under min(…, vw-16).
			expect(value.right.name, "the narrow-right panel must still run pop-in").toBe("pop-in");
			expect(value.right.left).toBeGreaterThanOrEqual(7.5);
			expect(value.right.right).toBeLessThanOrEqual(380 - 8 + 0.5);
			expect(value.right.width).toBeLessThanOrEqual(380 - 16 + 0.5);
			expect(value.right.width).toBeGreaterThanOrEqual(value.right.trigWidth - 0.5);
			// Bottom edge: the placement flips above the trigger with the +4 px entrance slide.
			expect(value.bottom.placement).toBe("top");
			expect(value.bottom.shift).toBe(4);
			expect(value.bottom.name).toBe("pop-in");
			expect(value.bottom.bottom).toBeLessThanOrEqual(value.bottom.trigTop + 0.5);
			expect(value.bottom.top).toBeGreaterThanOrEqual(7.5);
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
