import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The popover motion contract (W140): pop-in slides the popover 4 px from the anchor side it was placed on
// (--t-pop, --ease-out), pop-out fades it out over --t-close while it must not intercept clicks. The fixture renders
// the real ui.js Popover (bottom and top placement), the real model-menu.js EffortPicker (the overflow:visible slider),
// and a button under the popover to prove the closing animation does not eat clicks.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>';

const testJs = `
import { h, render } from '/vendor/preact.js';
import { Popover, useRef, useState } from '/js/ui.js';
import { EffortPicker } from '/js/model-menu.js';

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
var findPop = async function (sel) {
	for (var i = 0; i < 100; i++) {
		var pop = document.querySelector(sel);
		if (pop) return { pop: pop, mountedAt: performance.now() };
		await wait(2);
	}
	return null;
};

function TestApp() {
	var aB = useRef(null);
	var aT = useRef(null);
	var sB = useState(false);
	var sT = useState(false);
	window.__setOpenB = sB[1];
	window.__setOpenT = sT[1];
	window.__clicks = 0;
	var items = [];
	for (var i = 0; i < 12; i++) items.push(h('button', { key: i, class: 'pop-item' }, 'item ' + i));
	return h('div', {},
		h('div', { style: { position: 'absolute', top: '40px', left: '40px' } },
			h('button', { id: 'anchor-b', ref: aB, onClick: function () { sB[1](function (v) { return !v; }); } }, 'Bottom anchor')),
		h('div', { style: { position: 'absolute', top: '700px', left: '40px' } },
			h('button', { id: 'anchor-t', ref: aT, onClick: function () { sT[1](function (v) { return !v; }); } }, 'Top anchor')),
		h('button', { id: 'under-btn', style: { position: 'fixed', top: '200px', left: '100px' }, onClick: function () { window.__clicks += 1; } }, 'Under'),
		h('div', { style: { position: 'absolute', top: '420px', left: '420px' } },
			h(EffortPicker, { levels: ['low', 'medium', 'high'], value: 'medium', onChange: function () {} })),
		h(Popover, { anchor: aB, open: sB[0], onClose: function () { sB[1](false); }, placement: 'bottom', width: 220, maxHeight: 280, class: 'w140-bottom' }, items),
		h(Popover, { anchor: aT, open: sT[0], onClose: function () { sT[1](false); }, placement: 'top', width: 220, maxHeight: 280, class: 'w140-top' }, items));
}

var reducedCheck = async function () {
	window.__setOpenB(true);
	var found = await findPop('.popover.w140-bottom:not(.closing)');
	if (!found) return JSON.stringify({ error: 'popover not mounted under reduced motion' });
	await wait(16);
	var cs = getComputedStyle(found.pop);
	return JSON.stringify({
		reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
		name: cs.animationName,
		durMs: durMsOf(cs.animationDuration),
		transform: cs.transform,
		opacity: cs.opacity,
	});
};

render(h(TestApp, {}), document.getElementById('app'));

if (location.search.indexOf('mode=reduced') >= 0) {
	window.__reducedCheck = reducedCheck;
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">reduced-ready</p>');
} else {
	(async function () {
		var out = {};
		try {
			await wait(200);
			var rootCs = getComputedStyle(document.documentElement);
			var tPop = parseFloat(rootCs.getPropertyValue('--t-pop'));
			var tClose = parseFloat(rootCs.getPropertyValue('--t-close'));
			assert(tPop >= 140 && tPop <= 180, '--t-pop must be 140-180ms, got ' + tPop);
			assert(tClose >= 100 && tClose <= 120, '--t-close must be 100-120ms, got ' + tClose);
			assert(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'host has reduced motion on; the full-motion run needs it off');
			assert(document.documentElement.dataset.motion !== 'off', 'data-motion must not be off for the motion checks');
			var under = document.getElementById('under-btn');
			var ur = under.getBoundingClientRect();
			assert(ur.width > 20 && ur.height > 10, 'the under button has no box: ' + JSON.stringify(ur));
			var cx = Math.round(ur.left + ur.width / 2);
			var cy = Math.round(ur.top + ur.height / 2);

			// 1. Open a popover placed below its anchor: the entrance animation is pop-in at --t-pop with --ease-out,
			//    sampled within 20 ms of the popover mounting, and it slides from 4 px above (negative translateY).
			window.__setOpenB(true);
			var b = await findPop('.popover.w140-bottom:not(.closing)');
			assert(b, 'bottom popover never mounted');
			var csB = getComputedStyle(b.pop);
			var durB = durMsOf(csB.animationDuration);
			out.openBottom = {
				sampleMsAfterMount: Math.round(performance.now() - b.mountedAt),
				name: csB.animationName,
				durMs: durB,
				timing: csB.animationTimingFunction,
				fill: csB.animationFillMode,
				placement: b.pop.getAttribute('data-placement'),
				shift: parseFloat(csB.getPropertyValue('--pop-shift')),
				transform: csB.transform,
			};
			assert(out.openBottom.sampleMsAfterMount <= 20, 'sampled later than 20 ms after open: ' + out.openBottom.sampleMsAfterMount);
			assert(csB.animationName === 'pop-in', 'animation-name must be pop-in, got ' + csB.animationName);
			assert(Math.abs(durB - tPop) < 2, 'animation-duration must follow --t-pop (' + tPop + 'ms), got ' + durB);
			assert(csB.animationTimingFunction === 'cubic-bezier(0.2, 0.8, 0.2, 1)', 'timing must be --ease-out, got ' + csB.animationTimingFunction);
			assert(csB.animationFillMode === 'both', 'fill must be both, got ' + csB.animationFillMode);
			assert(b.pop.getAttribute('data-placement') === 'bottom', 'data-placement must be bottom, got ' + b.pop.getAttribute('data-placement'));
			assert(parseFloat(csB.getPropertyValue('--pop-shift')) === -4, '--pop-shift must be -4px below the anchor, got ' + csB.getPropertyValue('--pop-shift'));
			var tyB = tyOf(csB.transform);
			assert(tyB <= 0.5 && tyB >= -4.5, 'entrance must slide down from above (translateY -4..0), got ' + csB.transform);
			// The open popover does cover the button underneath it (it only stops taking clicks while closing).
			var prB = b.pop.getBoundingClientRect();
			assert(cx >= prB.left && cx <= prB.right && cy >= prB.top && cy <= prB.bottom, 'popover must overlap the under button: pop=' + JSON.stringify(prB) + ' point=' + cx + ',' + cy);
			var hitOpen = document.elementFromPoint(cx, cy);
			assert(hitOpen && b.pop.contains(hitOpen), 'open popover should cover the button under it, hit ' + (hitOpen ? hitOpen.id || hitOpen.className : 'null'));

			// 2. Placed above its anchor: --pop-shift flips to +4 px (slides up from below).
			window.__setOpenT(true);
			var t = await findPop('.popover.w140-top:not(.closing)');
			assert(t, 'top popover never mounted');
			var csT = getComputedStyle(t.pop);
			out.openTop = {
				placement: t.pop.getAttribute('data-placement'),
				shift: parseFloat(csT.getPropertyValue('--pop-shift')),
				name: csT.animationName,
				durMs: durMsOf(csT.animationDuration),
				transform: csT.transform,
			};
			assert(t.pop.getAttribute('data-placement') === 'top', 'data-placement must be top, got ' + t.pop.getAttribute('data-placement'));
			assert(parseFloat(csT.getPropertyValue('--pop-shift')) === 4, '--pop-shift must be +4px above the anchor, got ' + csT.getPropertyValue('--pop-shift'));
			assert(tyOf(csT.transform) >= -0.5 && tyOf(csT.transform) <= 4.5, 'entrance must slide up from below (translateY 0..4), got ' + csT.transform);

			// 3. Closing: .closing appears, pop-out at --t-close runs with pointer-events none, the element is gone within 200 ms.
			var closeT0 = performance.now();
			window.__setOpenT(false);
			await wait(10);
			var closing = document.querySelector('.popover.w140-top.closing');
			assert(closing, 'closing class never appeared');
			var csC = getComputedStyle(closing);
			var durC = durMsOf(csC.animationDuration);
			out.closing = { name: csC.animationName, durMs: durC, pointerEvents: csC.pointerEvents };
			assert(csC.animationName === 'pop-out', 'closing must run pop-out, got ' + csC.animationName);
			assert(Math.abs(durC - tClose) < 2, 'closing duration must follow --t-close (' + tClose + 'ms), got ' + durC);
			assert(csC.pointerEvents === 'none', 'closing popover must not take clicks, got ' + csC.pointerEvents);
			var removedMs = null;
			for (var i = 0; i < 60 && removedMs === null; i++) {
				if (!document.contains(closing)) removedMs = Math.round(performance.now() - closeT0);
				else await wait(5);
			}
			out.closing.removedMs = removedMs;
			assert(removedMs !== null && removedMs <= 200, 'closing popover must be removed within 200 ms, removed at ' + removedMs);

			// 4. Mid-close, clicks pass through to the button under the still-visible popover.
			var closeB0 = performance.now();
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await wait(30);
			var closingB = document.querySelector('.popover.w140-bottom.closing');
			assert(closingB, 'Esc must leave the bottom popover in .closing');
			var elapsed = performance.now() - closeB0;
			var hits = [];
			while (elapsed < 95) {
				var hit = document.elementFromPoint(cx, cy);
				hits.push(Math.round(elapsed) + ':' + (hit ? (hit.id || hit.className) : 'null'));
				if (hit && hit.id === 'under-btn') break;
				await wait(5);
				elapsed = performance.now() - closeB0;
			}
			var underHit = document.elementFromPoint(cx, cy);
			out.clickThrough = { elapsedMs: Math.round(elapsed), closingStillMounted: document.contains(closingB), hit: underHit ? underHit.id || underHit.className : null, hits: hits };
			assert(document.contains(closingB), 'the closing popover should still be mounted mid-animation at ' + Math.round(elapsed) + 'ms (removals early?)');
			assert(underHit && underHit.id === 'under-btn', 'clicks must pass through the closing popover, hit ' + (underHit ? underHit.id || underHit.className : 'null') + ' samples=' + hits.join(','));
			underHit.click();
			assert(window.__clicks === 1, 'the button under the closing popover must receive the click, clicks=' + window.__clicks);
			// The closing popover keeps fading and disappears on its own.
			for (var j = 0; j < 60 && document.contains(closingB); j++) await wait(5);
			assert(!document.contains(closingB), 'closing popover must still be removed after the click-through');

			// 5. The effort slider (overflow:visible) runs the same pop-in with nothing clipped or shifted:
			//    the thumb keeps a constant offset inside the popover box and the box stays fully visible.
			var ebtn = document.querySelector('button.chip[aria-haspopup="dialog"]');
			assert(ebtn, 'effort chip trigger not found');
			ebtn.click();
			var e = await findPop('.popover.effort-pop:not(.closing)');
			assert(e, 'effort popover never mounted');
			var csE = getComputedStyle(e.pop);
			assert(csE.animationName === 'pop-in', 'effort popover must use pop-in, got ' + csE.animationName);
			assert(csE.overflow === 'visible', 'effort popover must keep overflow visible, got ' + csE.overflow);
			var thumb = e.pop.querySelector('.effort-thumb');
			assert(thumb, 'effort thumb not found');
			var samples = [];
			for (var k = 0; k < 4; k++) {
				var want = [0, 40, 90, 180][k];
				var el = performance.now() - e.mountedAt;
				if (want > el) await wait(want - el);
				var pr = e.pop.getBoundingClientRect();
				var tr = thumb.getBoundingClientRect();
				samples.push({
					t: Math.round(performance.now() - e.mountedAt),
					popTop: pr.top, popLeft: pr.left,
					relTop: tr.top - pr.top, relLeft: tr.left - pr.left,
					inside: tr.left >= pr.left - 0.5 && tr.right <= pr.right + 0.5 && tr.top >= pr.top - 0.5 && tr.bottom <= pr.bottom + 0.5,
				});
			}
			await wait(200);
			var prR = e.pop.getBoundingClientRect();
			var trR = thumb.getBoundingClientRect();
			var relRestTop = trR.top - prR.top;
			var relRestLeft = trR.left - prR.left;
			for (var s = 0; s < samples.length; s++) {
				assert(samples[s].inside, 'effort thumb clipped outside the popover at t=' + samples[s].t + ' (pop overflow must keep it visible)');
				assert(Math.abs(samples[s].relTop - relRestTop) <= 1 && Math.abs(samples[s].relLeft - relRestLeft) <= 1, 'effort thumb shifted inside the popover at t=' + samples[s].t);
			}
			out.effort = { name: csE.animationName, durMs: durMsOf(csE.animationDuration), samples: samples, relRest: { top: relRestTop, left: relRestLeft } };

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
	"popover family animates with pop-in/pop-out and never blocks clicks",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-popover-motion-"));
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
				label: "Popover motion test",
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
	"prefers-reduced-motion (CDP emulated) keeps only a short fade with no slide",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-popover-reduced-"));
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
		// The bridge only exposes the tab commands; the raw send is needed for the emulation call.
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
				`popover must mount under reduced motion emulation: ${String(value.error)}`,
			).toBeUndefined();
			expect(value.reduced, "matchMedia must report the emulated reduce").toBe(true);
			expect(value.name).toBe("pop-in");
			expect(value.durMs).toBeLessThanOrEqual(60);
			expect(value.opacity).toBe("1");
			expect(
				value.transform === "none" || /matrix\(1, 0, 0, 1, 0, 0\)/u.test(String(value.transform)),
				`no slide may remain under reduced motion, transform=${value.transform}`,
			).toBe(true);
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
