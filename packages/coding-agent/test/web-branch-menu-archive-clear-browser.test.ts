import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// A long archived list leaves the branch popover at its 560px cap, and the clear button sits at the end of the capped
// copies region. The confirmation the button adds below the region therefore starts outside the popover's visible box:
// without scrolling it into view the click looked dead because the confirm button was never on screen.
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
var byText = async function (selector, pattern, ms) {
	for (var i = 0; i < Math.ceil((ms || 4000) / 20); i++) {
		var hit = Array.from(document.querySelectorAll(selector)).filter(function (el) { return pattern.test(el.textContent); })[0];
		if (hit) return hit;
		await wait(20);
	}
	return null;
};
var inside = function (box, host) { return box.top >= host.top - 1 && box.bottom <= host.bottom + 1; };

(async function () {
	var out = {};
	try {
		setView({ motion: 'on' });
		await wait(200);
		var chip = await find('.branch-chip');
		assert(chip, 'branch chip missing');
		chip.click();
		var header = await byText('button.branch-wt-group', /Archived/i, 4000);
		assert(header, 'archived group header missing');
		if (header.getAttribute('aria-expanded') !== 'true') header.click();
		// The group folds open and brings its clear button into the copies region; wait that out like a user does.
		await wait(900);
		var clear = await find('.branch-archive-end .branch-form button', 4000);
		assert(clear, 'clear button missing');
		assert(!clear.disabled, 'the clear button must be clickable when the chat is idle');
		clear.click();
		var panel = await find('.branch-delete-panel[aria-label]', 4000);
		assert(panel, 'no confirmation appeared after clicking clear');
		// The trigger must leave the list while its own confirmation is open: two red buttons saying the same thing read
		// as "the click opened a second clear button". It folds away with the shared motion.
		await wait(400);
		assert(!document.querySelector('.branch-archive-end .branch-form button'), 'the clear trigger stayed in the list under its own confirmation');
		assert(/Cancel/.test(document.activeElement && document.activeElement.textContent), 'the confirmation did not take the keyboard on Cancel');
		var popover = document.querySelector('.branch-pop').getBoundingClientRect();
		var box = panel.getBoundingClientRect();
		var confirm = panel.querySelector('.branch-form button');
		assert(/137/.test(confirm.textContent), 'the confirm button does not say how many copies it deletes: ' + confirm.textContent);
		var confirmBox = confirm.getBoundingClientRect();
		out.panel = [Math.round(box.top), Math.round(box.bottom)];
		out.confirm = [Math.round(confirmBox.top), Math.round(confirmBox.bottom)];
		out.popover = [Math.round(popover.top), Math.round(popover.bottom)];
		assert(box.height > 0, 'the confirmation is not rendered');
		assert(inside(box, popover), 'the confirmation to clear archived copies stayed outside the popover (' + JSON.stringify(out) + ')');
		assert(inside(confirmBox, popover), 'the confirm button stayed outside the popover (' + JSON.stringify(out) + ')');
		// The panel is reachable now, so the second click must really ask the server to delete the archived copies.
		confirm.click();
		await wait(700);
		var calls = await (await fetch('/api/test/calls')).json();
		out.clearCalls = calls.clear;
		assert(calls.clear === 1, 'the confirm click did not reach the clear route (' + JSON.stringify(out) + ')');
		assert(!document.querySelector('.branch-delete-panel[aria-label]'), 'the confirmation stayed open after clearing');
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
	let clearCalls = 0;
	for (const dir of ["js", "vendor", "css"]) {
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
	}
	server.route("GET", "/api/git/branches", () => ({
		branches: [{ name: "main", current: true, commit: "aaaa111", subject: "first", committedAt: 1790000000000 }],
	}));
	server.route("GET", "/api/git/worktrees", () => ({
		worktrees: [
			{ path: "C:/fixture", branch: "main", isMain: true, current: true },
			...(clearCalls ? [] : archivedCopies),
		],
	}));
	server.route("POST", "/api/git/worktrees/archive-sync", () => ({ released: 0, kept: [] }));
	server.route("POST", "/api/git/worktrees/archive/clear", () => {
		clearCalls += 1;
		return { removed: archivedCopies.length, failed: [] };
	});
	server.route("GET", "/api/test/calls", () => ({ clear: clearCalls }));
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
	"clearing archived copies shows its confirmation inside the branch popover",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-archive-clear-"));
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
				label: "Archived copies clear",
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
