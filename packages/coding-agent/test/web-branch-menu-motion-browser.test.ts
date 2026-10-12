import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// W142: the branch menu is a plain member of the Popover family now (no self-managed presence, no `leaving` class):
// pop-in on open (--t-pop, --ease-out), pop-out on close (--t-close) with pointer-events:none while it fades, and the
// keyboard returns to the chip when the menu really unmounts. The fixture renders the real BranchChip against mocked
// Git routes, plus a button under the popover to prove the closing animation never eats clicks.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><script type="module" src="/test/test.js"></script>';

const testJs = `
import { h, render } from '/vendor/preact.js';
import { BranchChip } from '/js/branch-menu.js';
import { setView } from '/js/store.js';

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
var until = async function (fn, ms) {
	var steps = Math.ceil((ms || 5000) / 50);
	for (var i = 0; i < steps; i++) { if (fn()) return true; await wait(50); }
	return false;
};
var key = function (el, k) { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };
var currentBranch = async function () {
	return (await fetch('/api/test/current').then(function (r) { return r.json(); })).current;
};

render(h(BranchChip, { gitStatus: { branch: 'main', isRepository: true } }), document.getElementById('app'));
document.getElementById('app').style.cssText = 'position:fixed;bottom:20px;left:40px';

if (location.search.indexOf('mode=reduced') >= 0) {
	window.__reducedCheck = async function () {
		var chip = document.querySelector('.branch-chip');
		if (!chip) return JSON.stringify({ error: 'chip not found' });
		if (!document.querySelector('.branch-pop')) chip.click();
		var found = await findPop('.branch-pop');
		if (!found) return JSON.stringify({ error: 'popover not mounted under reduced motion' });
		await wait(20);
		var cs = getComputedStyle(found.pop);
		return JSON.stringify({
			reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
			name: cs.animationName,
			durMs: durMsOf(cs.animationDuration),
			transform: cs.transform,
			opacity: cs.opacity,
		});
	};
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">reduced-ready</p>');
} else {
	(async function () {
		var out = {};
		try {
			setView({ motion: 'on' });
			await wait(200);
			var rootCs = getComputedStyle(document.documentElement);
			var tPop = parseFloat(rootCs.getPropertyValue('--t-pop'));
			var tClose = parseFloat(rootCs.getPropertyValue('--t-close'));
			assert(tPop >= 140 && tPop <= 180, '--t-pop must be 140-180ms, got ' + tPop);
			assert(tClose >= 100 && tClose <= 120, '--t-close must be 100-120ms, got ' + tClose);
			assert(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'host has reduced motion on; the full-motion run needs it off');
			assert(document.documentElement.dataset.motion === 'on', 'data-motion must be on for the motion checks');
			var chip = document.querySelector('.branch-chip');
			assert(chip, 'branch chip missing');

			// 1. Open: pop-in at --t-pop with --ease-out, 4 px slide from the anchor side, fixed 330 x 480, no self-managed classes.
			chip.click();
			var a = await findPop('.branch-pop');
			assert(a, 'branch popover never mounted');
			var csA = getComputedStyle(a.pop);
			out.openAtMount = {
				sampleMsAfterMount: Math.round(performance.now() - a.mountedAt),
				cls: a.pop.className,
				name: csA.animationName,
				durMs: durMsOf(csA.animationDuration),
				timing: csA.animationTimingFunction,
				fill: csA.animationFillMode,
				placement: a.pop.getAttribute('data-placement'),
				shift: parseFloat(csA.getPropertyValue('--pop-shift')),
				transform: csA.transform,
				width: a.pop.getBoundingClientRect().width,
				maxHeight: csA.maxHeight,
			};
			assert(out.openAtMount.sampleMsAfterMount <= 20, 'sampled later than 20 ms after open: ' + out.openAtMount.sampleMsAfterMount);
			assert(csA.animationName === 'pop-in', 'animation-name must be pop-in, got ' + csA.animationName);
			assert(Math.abs(out.openAtMount.durMs - tPop) < 2, 'animation-duration must follow --t-pop (' + tPop + 'ms), got ' + out.openAtMount.durMs);
			assert(csA.animationTimingFunction === 'cubic-bezier(0.2, 0.8, 0.2, 1)', 'timing must be --ease-out, got ' + csA.animationTimingFunction);
			assert(csA.animationFillMode === 'both', 'fill must be both, got ' + csA.animationFillMode);
			// Direction-aware entrance: the slide starts from the edge the popover really landed on (the fixture window
			// can flip top placements to bottom on short viewports; the real app above a bottom chip stays top).
			var placed = a.pop.getAttribute('data-placement');
			assert(placed === 'top' || placed === 'bottom', 'data-placement must be top or bottom, got ' + placed);
			assert(out.openAtMount.shift === (placed === 'top' ? 4 : -4), '--pop-shift must follow the landed side (' + placed + '), got ' + out.openAtMount.shift);
			assert(tyOf(csA.transform) >= (placed === 'top' ? -0.5 : -4.5) && tyOf(csA.transform) <= (placed === 'top' ? 4.5 : 0.5), 'entrance must slide from the landed side (translateY 0..' + (placed === 'top' ? '4' : '-4') + '), got ' + csA.transform);
			assert(!a.pop.className.includes('leaving'), 'the self-managed leaving class must be gone, cls=' + a.pop.className);
			assert(out.openAtMount.width === 330, 'branch popover must stay 330 wide, got ' + out.openAtMount.width);
			assert(out.openAtMount.maxHeight === '480px', 'branch popover must keep maxHeight 480px, got ' + out.openAtMount.maxHeight);

			// The branch list and the search box behave as before.
			assert(await until(function () { return document.querySelectorAll('.branch-row').length === 3; }, 5000), 'branch rows never rendered');
			var input = document.querySelector('.pop-search input');
			assert(input && document.activeElement === input, 'the search input must be focused while open');
			await wait(200);
			var r0 = a.pop.getBoundingClientRect();
			var cx = Math.round(r0.left + r0.width / 2);
			var cy = Math.round(r0.top + r0.height / 2);
			var hitOpen = document.elementFromPoint(cx, cy);
			assert(hitOpen && a.pop.contains(hitOpen), 'open popover should cover the point under it');

			// 2. Search filters the rows (rankSearch) and clearing restores them.
			input.value = 'alpha';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			assert(await until(function () { return document.querySelectorAll('.branch-row').length === 1; }, 2000), 'search did not filter to feat-alpha');
			assert(document.querySelector('.branch-row .branch-name').textContent === 'feat-alpha', 'wrong row after filtering');
			input.value = '';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			assert(await until(function () { return document.querySelectorAll('.branch-row').length === 3; }, 2000), 'clearing the search did not restore the rows');
			out.search = 'ok';

			// 3. Keyboard: ArrowDown/ArrowUp move the highlight, Enter switches (and closes).
			assert(document.querySelector('.branch-row.hi .branch-name').textContent === 'main', 'first row must be highlighted');
			key(input, 'ArrowDown');
			assert(await until(function () { var el = document.querySelector('.branch-row.hi'); return el && el.textContent.includes('feat-alpha'); }, 2000), 'ArrowDown must highlight feat-alpha');
			key(input, 'ArrowDown');
			assert(await until(function () { var el = document.querySelector('.branch-row.hi'); return el && el.textContent.includes('fix-beta'); }, 2000), 'ArrowDown must highlight fix-beta');
			key(input, 'ArrowUp');
			assert(await until(function () { var el = document.querySelector('.branch-row.hi'); return el && el.textContent.includes('feat-alpha'); }, 2000), 'ArrowUp must highlight feat-alpha');
			key(input, 'Enter');
			var switched = false;
			for (var q = 0; q < 40 && !switched; q++) {
				switched = (await currentBranch()) === 'feat-alpha';
				if (!switched) await wait(50);
			}
			assert(switched, 'Enter must switch to the highlighted branch');
			assert(await until(function () { return !document.querySelector('.branch-pop'); }, 500), 'switching must close the popover');
			out.keyboard = 'ok';

			// 4. Esc closes with .closing + pop-out + pointer-events:none; clicks land on the control under it; the
			//    element is gone within 200 ms and the keyboard returns to the chip. No leaving class anywhere.
			chip.click();
			var b = await findPop('.branch-pop:not(.closing)');
			assert(b, 'branch popover never reopened');
			await wait(220);
			var input2 = b.pop.querySelector('.pop-search input');
			if (input2 && document.activeElement !== input2) input2.focus();
			var under = document.createElement('button');
			under.id = 'under-btn';
			under.textContent = 'under';
			under.style.cssText = 'position:fixed;left:' + (cx - 10) + 'px;top:' + (cy - 10) + 'px;width:20px;height:20px;z-index:1';
			window.__clicks = 0;
			under.addEventListener('click', function () { window.__clicks += 1; });
			document.body.appendChild(under);
			var pr = b.pop.getBoundingClientRect();
			assert(cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom, 'popover moved before closing: ' + JSON.stringify(pr));
			var t0 = performance.now();
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await wait(8);
			var closing = document.querySelector('.branch-pop');
			assert(closing, 'closing popover must still be mounted at 8 ms (presence is the popover\\u2019s own now)');
			assert(closing.classList.contains('closing'), 'closing class must be applied, cls=' + closing.className);
			assert(!closing.classList.contains('leaving'), 'the leaving class must be gone, cls=' + closing.className);
			var csC = getComputedStyle(closing);
			out.closing = { name: csC.animationName, durMs: durMsOf(csC.animationDuration), pointerEvents: csC.pointerEvents };
			assert(csC.animationName === 'pop-out', 'closing must run pop-out, got ' + csC.animationName);
			assert(Math.abs(out.closing.durMs - tClose) < 2, 'closing duration must follow --t-close (' + tClose + 'ms), got ' + out.closing.durMs);
			assert(csC.pointerEvents === 'none', 'the closing popover must not take clicks, got ' + csC.pointerEvents);
			assert(input2 && document.activeElement === input2, 'closing must not move the keyboard yet (it returns to the chip only when the menu unmounts)');
			var underHit = document.elementFromPoint(cx, cy);
			assert(underHit && underHit.id === 'under-btn', 'clicks must pass through the closing popover, hit ' + (underHit ? underHit.id || underHit.className : 'null'));
			underHit.click();
			assert(window.__clicks === 1, 'the button under the closing popover must receive the click, clicks=' + window.__clicks);
			var removedMs = null;
			for (var j = 0; j < 60 && removedMs === null; j++) {
				if (!document.contains(closing)) removedMs = Math.round(performance.now() - t0);
				else await wait(5);
			}
			out.closing.removedMs = removedMs;
			assert(removedMs !== null && removedMs <= 200, 'closing popover must be removed within 200 ms, removed at ' + removedMs);
			// The keyboard goes back to the chip once the menu is really gone (existing behavior, unchanged).
			assert(await until(function () { return document.activeElement === chip; }, 400), 'focus must return to the branch chip after close, active=' + document.activeElement.tagName);
			under.remove();

			document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed ' + JSON.stringify(out) + '</p>');
		} catch (err) {
			document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + ' ' + JSON.stringify(out) + '</p>');
		}
	})();
}
`;

function serveFixture(root: string, gitState: { current: string }) {
	const server = new WebHttpServer();
	for (const dir of ["js", "vendor", "css"]) {
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
	}
	server.route("GET", "/api/git/branches", () => ({
		branches: [
			{
				name: "main",
				current: gitState.current === "main",
				commit: "aaaa111",
				subject: "first",
				committedAt: 1790000000000,
			},
			{
				name: "feat-alpha",
				current: gitState.current === "feat-alpha",
				commit: "bbbb222",
				subject: "alpha",
				committedAt: 1790000001000,
			},
			{
				name: "fix-beta",
				current: gitState.current === "fix-beta",
				commit: "cccc333",
				subject: "beta",
				committedAt: 1790000002000,
			},
		],
	}));
	server.route("GET", "/api/git/worktrees", () => ({
		worktrees: [{ path: "C:/fixture", isMain: true, current: true }],
	}));
	server.route("GET", "/api/git/status", () => ({
		gitAvailable: true,
		isRepository: true,
		root: "C:/fixture",
		branch: gitState.current,
	}));
	server.route("GET", "/api/test/current", () => ({ current: gitState.current }));
	server.route("POST", "/api/git/branches/switch", ({ body }) => {
		const name = String((body as { name?: unknown }).name ?? "");
		if (name) gitState.current = name;
		return { ok: true };
	});
	server.mount({ prefix: "/test/", directory: root });
	writeFileSync(join(root, "index.html"), indexHtml);
	writeFileSync(join(root, "test.js"), testJs);
	server.setIndexFile(join(root, "index.html"));
	return server;
}

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"branch menu opens and closes with the shared popover motion and keeps its keyboard and search behavior",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-branch-motion-"));
		const gitState = { current: "main" };
		const server = serveFixture(root, gitState);
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		try {
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Branch menu motion test",
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
	"prefers-reduced-motion (CDP emulated) leaves the branch popover without a slide",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-branch-reduced-"));
		const gitState = { current: "main" };
		const server = serveFixture(root, gitState);
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
				`branch popover must open under reduced motion emulation: ${String(value.error)}`,
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
