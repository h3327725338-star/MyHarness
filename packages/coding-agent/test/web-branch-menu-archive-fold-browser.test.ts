import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// A finished-copy group holds far more rows than the copies region can show. The shared fold animates the block's real
// height, so with 137 rows the visible part filled within one frame and the group looked like it popped open. The list is
// capped now; this measures the motion from the click and requires it to ease over --t-slow instead of jumping.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/panels.css"><link rel="stylesheet" href="/css/overlays.css"><link rel="stylesheet" href="/css/composer.css"><div id="app"></div><script type="module" src="/test/test.js"></script>';

const testJs = `
import { h, render } from '/vendor/preact.js';
import { BranchChip } from '/js/branch-menu.js';
import { setView } from '/js/store.js';

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
render(h(BranchChip, { gitStatus: { branch: 'main', isRepository: true } }), document.getElementById('app'));
document.getElementById('app').style.cssText = 'position:fixed;bottom:20px;left:40px';
var assert = function (ok, msg) { if (!ok) throw Error(msg); };
var find = async function (sel, ms) {
	var steps = Math.ceil((ms || 4000) / 20);
	for (var i = 0; i < steps; i++) { var el = document.querySelector(sel); if (el) return el; await wait(20); }
	return null;
};

/** Click, then record how much of the block is really visible inside the copies region, every frame. */
var sampleFold = function (header, ms) {
	header.click();
	var start = performance.now();
	return new Promise(function (resolve) {
		var rows = [];
		var step = function () {
			var region = document.querySelector('.branch-copy-region');
			var list = document.querySelector('.branch-copies-long');
			var block = list && list.closest('.collapse');
			var visible = 0;
			if (region && block) {
				var rr = region.getBoundingClientRect();
				var br = block.getBoundingClientRect();
				visible = Math.max(0, Math.min(br.bottom, rr.bottom) - Math.max(br.top, rr.top));
			}
			rows.push({ t: Math.round(performance.now() - start), v: Math.round(visible * 10) / 10 });
			if (performance.now() - start < ms) requestAnimationFrame(step);
			else resolve(rows);
		};
		requestAnimationFrame(step);
	});
};

(async function () {
	var out = {};
	try {
		setView({ motion: 'on' });
		await wait(200);
		assert(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'the host must allow motion');
		var chip = await find('.branch-chip');
		assert(chip, 'branch chip missing');
		chip.click();
		var header = null;
		for (var i = 0; i < 200 && !header; i++) {
			header = Array.from(document.querySelectorAll('button.branch-wt-group')).filter(function (b) {
				return /Archived/i.test(b.textContent);
			})[0];
			if (!header) await wait(20);
		}
		assert(header, 'archived group header missing');
		assert(header.getAttribute('aria-expanded') === 'false', 'the archived group must start folded');
		var rows = await sampleFold(header, 700);
		var peak = 0;
		rows.forEach(function (row) { peak = Math.max(peak, row.v); });
		var nearest = function (target) {
			var best = rows[0];
			rows.forEach(function (row) { if (Math.abs(row.t - target) < Math.abs(best.t - target)) best = row; });
			return best;
		};
		var mid = nearest(120);
		out.peakVisible = peak;
		out.midAt = mid.t;
		out.midVisible = mid.v;
		out.midRatio = peak > 0 ? Math.round((mid.v / peak) * 100) / 100 : 1;
		out.firstFrames = rows.slice(0, 8);
		out.listRows = document.querySelectorAll('.branch-copies-long .branch-copy').length;
		assert(out.listRows === 137, 'all archived rows must stay reachable, got ' + out.listRows);
		var copyRows = document.querySelectorAll('.branch-copies-long .branch-copy');
		var first = copyRows[0].getBoundingClientRect();
		var second = copyRows[1].getBoundingClientRect();
		// The capped list must scroll, not shrink its rows to fit: each row keeps the main copy row's height.
		var mainHeight = document.querySelector('.branch-list .branch-row').getBoundingClientRect().height;
		out.rowHeight = Math.round(first.height * 10) / 10;
		assert(
			first.height >= mainHeight - 0.5 && second.top >= first.bottom - 0.5,
			'capped list squeezed its rows so they overlap (row ' + out.rowHeight + 'px, main row ' + mainHeight + 'px)'
		);
		assert(peak > 80, 'the archived group did not open: only ' + peak + 'px visible');
		assert(
			out.midRatio <= 0.75,
			'the group was already ' + Math.round(out.midRatio * 100) + '% open at ' + mid.t + 'ms (peak ' + peak + 'px): it pops instead of easing over --t-slow'
		);
		// Once open, the group's clear button is scrolled into the copies region instead of being left below its edge.
		await wait(800);
		var region = document.querySelector('.branch-copy-region').getBoundingClientRect();
		var clear = document.querySelector('.branch-copies-long').parentElement.querySelector('.branch-form button').getBoundingClientRect();
		out.clearButton = [Math.round(clear.top), Math.round(clear.bottom), Math.round(region.top), Math.round(region.bottom)];
		assert(clear.top >= region.top - 0.5 && clear.bottom <= region.bottom + 0.5, 'the clear button is cut off below the copies region');
		document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed ' + JSON.stringify(out) + '</p>');
	} catch (err) {
		document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + ' ' + JSON.stringify(out) + '</p>');
	}
})();
`;

const archivedCopies = Array.from({ length: 137 }, (_unused, index) => ({
	path: `C:/fixture/archived-${String(index + 1).padStart(3, "0")}`,
	branch: `task-0920-${String(1000 + index)}`,
	isMain: false,
	locked: false,
	current: false,
	changes: 0,
	ahead: 0,
	merged: null,
	subagent: false,
	origin: "external",
	archived: true,
	archivedAt: "2026-10-13T10:51:00.000Z",
	archiveReason: "temporary",
	displayName: `bench-${index + 1}`,
}));

function serveFixture(root: string) {
	const server = new WebHttpServer();
	for (const dir of ["js", "vendor", "css"]) {
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
	}
	server.route("GET", "/api/git/branches", () => ({
		branches: [
			{ name: "main", current: true, commit: "aaaa111", subject: "first", committedAt: 1790000000000 },
			{
				name: "task-0920-1000",
				current: false,
				commit: "bbbb222",
				subject: "second",
				committedAt: 1790000001000,
			},
		],
	}));
	server.route("GET", "/api/git/worktrees", () => ({
		worktrees: [{ path: "C:/fixture", branch: "main", isMain: true, current: true }, ...archivedCopies],
	}));
	server.route("POST", "/api/git/worktrees/archive-sync", () => ({ released: 0, kept: [] }));
	server.route("GET", "/api/git/status", () => ({
		gitAvailable: true,
		isRepository: true,
		root: "C:/fixture",
		branch: "main",
	}));
	server.mount({ prefix: "/test/", directory: root });
	writeFileSync(join(root, "index.html"), indexHtml);
	writeFileSync(join(root, "test.js"), testJs);
	server.setIndexFile(join(root, "index.html"));
	return server;
}

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"the archived copies group folds open with the shared motion instead of popping in",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-archive-fold-"));
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
				label: "Archived copies fold",
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
