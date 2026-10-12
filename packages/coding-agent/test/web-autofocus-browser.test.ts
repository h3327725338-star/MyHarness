import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// W205: the global autofocus MutationObserver became reference-counted and lazy. Floating layers (ui.js Modal, Overlay,
// Popover) hold the scan while they are mounted/open; inline `[autofocus]` fields (the rename boxes, the composer ask
// dialogs) focus themselves through the `autofocusOnMount` ref. While the page idles (streaming, typing, scrolling) no
// observer is attached at all. Every `autofocus` use point in web/js has an "opens and focuses" assertion here (the
// site list is in the W205 receipt): this file drives the real ui.js primitives and, where a component is mountable
// standalone, the real component (CommandPalette, FolderPicker, EffortSlider, Sidebar, Composer); the deep inline rows
// (header rename, provider-form rows, the ask-dialog shapes) use the same helper in the same markup shape.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/layout.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="side" style="width:320px;height:600px;display:flex;flex-direction:column"></div><div id="app"></div><script type="module" src="/test/test.js"></script>';

// The shared fixture prelude: wait/until/assert + an error trap. Every fixture ends by writing #ready.
const prelude = `
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
var assert = function (ok, msg) { if (!ok) throw Error(msg); };
var until = async function (fn, ms) {
	var t0 = Date.now();
	for (;;) {
		if (fn()) return true;
		if (Date.now() - t0 > (ms || 2500)) return false;
		await wait(15);
	}
};
var act = function (el, type) { el.dispatchEvent(new MouseEvent(type, { bubbles: true })); };
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
`;

function serveFixture(root: string, testJs: string, withApi = false) {
	const server = new WebHttpServer();
	for (const dir of ["js", "vendor", "css"]) {
		server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
	}
	if (withApi) {
		// The same stubs the sidebar-virtualization fixture uses (Sidebar) plus an empty git status (Composer).
		server.route("GET", "/api/slots", () => ({ slots: [] }));
		server.route("GET", "/api/state", () => ({
			items: [],
			session: null,
			app: {},
			flags: {},
			thinking: {},
			trust: { trusted: true },
			surface: { widgets: {}, statuses: {} },
			skills: [],
			templates: [],
			extensions: [],
		}));
		server.route("GET", "/api/models", () => ({ models: [] }));
		server.route("GET", "/api/git/status", () => ({ gitAvailable: false, isRepository: false }));
		server.route("GET", "/api/transcript", () => ({ items: [] }));
		server.route("POST", "/api/sessions/open", () => ({ slot: "s-opened", created: true }));
		// The folder picker's browse/places reads (the picker starts in a non-empty path so New folder is enabled).
		server.route("GET", "/api/fs/browse", () => ({
			path: "C:/probe",
			dirs: [{ name: "alpha", path: "C:/probe/alpha" }],
		}));
		server.route("GET", "/api/fs/places", () => ({
			places: [],
			drives: [{ id: "C", name: "C:", path: "C:/" }],
			current: "",
		}));
	}
	server.mount({ prefix: "/test/", directory: root });
	writeFileSync(join(root, "index.html"), indexHtml);
	writeFileSync(join(root, "test.js"), testJs);
	server.setIndexFile(join(root, "index.html"));
	return server;
}

async function runFixture(name: string, testJs: string, withApi = false): Promise<string> {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), `myharness-${name}-`));
	const server = serveFixture(root, testJs, withApi);
	const browser = new LocalBrowser({
		kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
		rootDir: join(root, "browser"),
	});
	try {
		const { port } = await server.listen(0);
		const page = await browser.solveChallenge({
			url: `http://127.0.0.1:${port}/`,
			readySelector: "#ready",
			label: name,
			isSolved: (candidate) => candidate.text.includes('id="ready">'),
		});
		return page.text;
	} finally {
		await browser.shutdown();
		await server.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
}

const skipIf = !process.env.MYHARNESS_TARGETED_BROWSER_E2E || installed.length === 0;

it.skipIf(skipIf)(
	"no autofocus scan is attached while the page idles, layers hold and release it by reference count",
	async () => {
		const text = await runFixture(
			"autofocus-idle",
			`${prelude}
import {h,render} from '/vendor/preact.js';
import {Modal, useState, autofocusScanCount, releaseAutofocusScan} from '/js/ui.js';
function Holder() {
	var st = useState(false);
	window.__setOpen = st[1];
	return h('div', {},
		h('button', { id: 'open', onClick: function () { st[1](true); } }, 'open'),
		st[0] ? h(Modal, { title: 'Scan holder', onClose: function () { st[1](false); } }, h('p', {}, 'plain body')) : null
	);
}
function stray(tag) {
	var box = document.createElement('div');
	box.innerHTML = '<input autofocus id="stray-' + tag + '">';
	document.body.appendChild(box);
	return box.firstChild;
}
try {
	assert(autofocusScanCount() === 0, 'fresh page must hold no scan, got ' + autofocusScanCount());
	// Warm the keyboard up first: the browser honours a freshly parsed autofocus attribute until the page has focused
	// something once. Without this warm-up the native parser focus could be mistaken for the removed observer.
	var warm = document.createElement('button');
	document.body.appendChild(warm);
	warm.focus();
	assert(document.activeElement === warm, 'warm-up focus must give the keyboard to the button');
	// A stray autofocus insert (no layer open) must NOT take the keyboard: the old document-wide observer did.
	var s1 = stray('a');
	await wait(150);
	assert(document.activeElement !== s1, 'a stray autofocus mount must stay unfocused while no layer is open');
	// An open Modal holds the scan; a stray insert is then focused exactly like before (content added after mount).
	render(h(Holder), document.getElementById('app'));
	document.getElementById('open').click();
	assert(await until(function () { return autofocusScanCount() === 1; }, 2000), 'an open Modal must hold exactly one scan');
	var s2 = stray('b');
	assert(await until(function () { return document.activeElement === s2; }, 2000), 'with a Modal open a later autofocus insert must be focused (scan active)');
	window.__setOpen(false);
	assert(await until(function () { return autofocusScanCount() === 0; }, 2000), 'closing the Modal must release the scan back to zero');
	var s3 = stray('c');
	await wait(150);
	assert(document.activeElement !== s3, 'after the last layer closed the scan must be gone again');
	// An extra release must never drag the count below zero (an unbalanced caller cannot disable other layers).
	releaseAutofocusScan();
	assert(autofocusScanCount() === 0, 'release below zero must be clamped, got ' + autofocusScanCount());
	assert(window.__errors.length === 0, 'page errors: ' + window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed</p>');
} catch (err) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + '</p>');
}
`,
		);
		expect(text).toContain('id="ready">passed');
	},
	60000,
);

it.skipIf(skipIf)(
	"Modal autofocus fields (confirm footer button, input dialog, provider-form shapes) focus on open",
	async () => {
		const text = await runFixture(
			"autofocus-modal",
			`${prelude}
import {h,render} from '/vendor/preact.js';
import {Modal, Overlay, useState, autofocusScanCount} from '/js/ui.js';
// The ConfirmModal shape (app.js:135): a footer button carries the autofocus attribute, the body has no plain input.
// The InputModal shape (app.js:147): an autofocus input in the body. The provider-form shapes (441 autofocus at
// mount; 215 a model row added later with autofocus). All ride the real Overlay+Modal pair like app.js:253/254.
function Holder() {
	var which = useState(null);
	window.__which = which[1];
	var models = useState([]);
	var d = which[0];
	return h('div', {},
		h('button', { id: 'c-confirm', onClick: function () { which[1]('confirm'); } }, 'confirm'),
		h('button', { id: 'c-input', onClick: function () { which[1]('input'); } }, 'input'),
		h('button', { id: 'c-provider', onClick: function () { which[1]('provider'); } }, 'provider'),
		h(Overlay, { show: !!d }, d ? h(Modal, {
			title: 'Dialog ' + d,
			onClose: function () { which[1](null); },
			footer: d === 'confirm' ? h('span', {},
				h('button', { class: 'btn', onClick: function () { which[1](null); } }, 'Cancel'),
				h('button', { class: 'btn primary', autofocus: true, id: 'confirm-ok' }, 'Delete')) : null,
		},
			d === 'confirm' ? h('div', { class: 'pre-wrap' }, 'Remove this chat?') : null,
			d === 'input' ? h('label', { class: 'col field-label' }, 'New name', h('input', { class: 'field', autofocus: true, id: 'prompt-input' })) : null,
			d === 'provider' ? h('div', {},
				h('label', {}, 'Name', h('input', { class: 'field', autofocus: true, id: 'pf-name', value: '' })),
				h('button', { id: 'pf-add-model', onClick: function () { models[1](models[0].concat([{ id: '', key: 'm' + models[0].length }])); } }, 'Add model'),
				models[0].map(function (m) { return h('label', { key: m.key }, 'Model ID', h('input', { class: 'field mono', autofocus: m.id ? undefined : true, id: 'model-' + m.key, value: m.id })); }),
			) : null,
		) : null)
	);
}
try {
	render(h(Holder), document.getElementById('app'));
	document.getElementById('c-confirm').click();
	assert(await until(function () { return document.activeElement && document.activeElement.id === 'confirm-ok'; }, 2500), 'the autofocus footer button of a confirm dialog must take the keyboard on open (active=' + (document.activeElement && document.activeElement.id) + ')');
	assert(await until(function () { return autofocusScanCount() >= 1; }, 2500), 'the open overlay pair must hold the scan');
	window.__which(null);
	await wait(300);
	assert(await until(function () { return autofocusScanCount() === 0; }, 2000), 'closing must release the scan back to zero');
	document.getElementById('c-input').click();
	assert(await until(function () { return document.activeElement && document.activeElement.id === 'prompt-input'; }, 2500), 'the InputModal autofocus input must take the keyboard on open');
	window.__which(null);
	await wait(300);
	document.getElementById('c-provider').click();
	assert(await until(function () { return document.activeElement && document.activeElement.id === 'pf-name'; }, 2500), 'the provider-form Name field (autofocus at mount) must take the keyboard on open');
	// A model row added after the editor mounted carries autofocus when its id is empty (provider-form.js:215): the held scan focuses it.
	document.getElementById('pf-add-model').click();
	assert(await until(function () { return document.activeElement && document.activeElement.id === 'model-m0'; }, 2500), 'a later-inserted autofocus model row must take the keyboard while the editor is open');
	window.__which(null);
	assert(await until(function () { return autofocusScanCount() === 0; }, 2000), 'closing everything must leave zero holders');
	assert(window.__errors.length === 0, 'page errors: ' + window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed</p>');
} catch (err) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + '</p>');
}
`,
		);
		expect(text).toContain('id="ready">passed');
	},
	60000,
);

it.skipIf(skipIf)(
	"the command palette focuses its search box on open and the folder picker focuses fields the moment they appear",
	async () => {
		const text = await runFixture(
			"autofocus-palette",
			`${prelude}
import {h,render} from '/vendor/preact.js';
import {Overlay, useState, autofocusScanCount} from '/js/ui.js';
import {CommandPalette} from '/js/palette.js';
import {FolderPicker} from '/js/folder-picker.js';
import {setView, useStore} from '/js/store.js';
function App() {
	var pal = useStore(function (s) { return s.view.palette; });
	var folder = useState(false);
	return h('div', {},
		// The palette mounts exactly the way app.js:251 does: an Overlay holding CommandPalette (no Modal between).
		h(Overlay, { show: !!pal }, pal ? h(CommandPalette, {}) : null),
		h('button', { id: 'folder-opener', onClick: function () { folder[1](true); } }, 'open folder'),
		folder[0] ? h(FolderPicker, { title: 'Add workspace', confirmLabel: 'Add', onClose: function () { folder[1](false); }, onPick: function () {} }) : null
	);
}
try {
	setView({ lang: 'en', motion: 'off' });
	setView({ palette: true });
	render(h(App), document.getElementById('app'));
	// 1. The palette input (palette.js:114) lives directly under an Overlay: opening the palette must focus it.
	assert(await until(function () {
		var i = document.querySelector('.palette-input input');
		return i && document.activeElement === i;
	}, 2500), 'the command palette search input must be focused the moment it opens (active=' + (document.activeElement && document.activeElement.className) + ')');
	assert(await until(function () { return autofocusScanCount() >= 1; }, 2500), 'an open Overlay must hold the scan');
	setView({ palette: false });
	assert(await until(function () { return autofocusScanCount() === 0; }, 2500), 'closing the palette must release the scan');
	// 2. The folder picker (Overlay holding a Modal): the keyboard lands inside the dialog on open.
	document.getElementById('folder-opener').click();
	assert(await until(function () {
		var host = document.querySelector('.fp-modal');
		if (!host) return false;
		var a = document.activeElement;
		return a && host.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.matches('[autofocus]'));
	}, 4000), 'the folder picker must land the keyboard inside the dialog on open');
	assert(await until(function () { return autofocusScanCount() >= 1; }, 2500), 'the open picker must hold the scan');
	// 3. The new-folder row (folder-picker.js:199) is added after the picker mounted: the held scan must focus it.
	var newBtn = [...document.querySelectorAll('.fp-tools button')].find(function (b) { return /New folder/.test(b.textContent); });
	assert(newBtn, 'new folder button missing');
	newBtn.click();
	assert(await until(function () { return document.activeElement && document.querySelector('.fp-row.creating input') === document.activeElement; }, 2500), 'the new-folder input must be focused the moment it appears');
	// Blur drops the creating row (onBlur cancels when there is no error). Escape here would hit the Modal's
	// window-capture Escape handler and close the whole picker, exactly as it does in the real app.
	document.activeElement.blur();
	await wait(150);
	// 4. The address edit (folder-picker.js:178) swaps in when the crumbs bar is clicked.
	var crumbs = document.querySelector('.fp-address.crumbs');
	assert(crumbs, 'crumb bar missing');
	crumbs.click();
	assert(await until(function () { return document.activeElement && document.activeElement.classList.contains('fp-address'); }, 2500), 'the address edit input must be focused the moment it appears');
	// Close the picker: the scan must fall back to zero.
	var cancel = [...document.querySelectorAll('.fp-modal .modal-foot button')].find(function (b) { return /Cancel/.test(b.textContent); });
	assert(cancel, 'picker cancel missing');
	cancel.click();
	assert(await until(function () { return !document.querySelector('.fp-modal') && autofocusScanCount() === 0; }, 3000), 'closing the picker must unmount it and release the scan');
	assert(window.__errors.length === 0, 'page errors: ' + window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed</p>');
} catch (err) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + '</p>');
}
`,
			true,
		);
		expect(text).toContain('id="ready">passed');
	},
	60000,
);

it.skipIf(skipIf)(
	"popovers focus their autofocus field on open (branch and model search, new-branch form, effort slider)",
	async () => {
		const text = await runFixture(
			"autofocus-popover",
			`${prelude}
import {h,render} from '/vendor/preact.js';
import {Popover, useState, autofocusScanCount} from '/js/ui.js';
import {EffortSlider} from '/js/model-menu.js';
// Site shapes copied from the call sites: branch-menu.js:262 / model-menu.js:79 (div.pop-search with input[autofocus]
// mounted at open), branch-menu.js:292 (a form input[autofocus] added while the popover is open), model-menu.js:179
// and 209 (EffortSlider with autoFocus inside a Popover).
var anchor = { current: null };
var eAnchor = { current: null };
function Holder() {
	var open = useState(false);
	var effort = useState(false);
	var creating = useState(false);
	window.__open = open[1];
	window.__setEffort = effort[1];
	return h('div', {},
		h('button', { id: 'chip', ref: function (el) { anchor.current = el; } }, 'branch chip'),
		h(Popover, { anchor: anchor, open: open[0], onClose: function () { open[1](false); }, width: 330 },
			h('div', { class: 'pop-search' }, h('input', { autofocus: true, id: 'pop-search-input', placeholder: 'Search branches' })),
			creating[0] ? h('form', { class: 'branch-form' }, h('input', { class: 'field sm grow', id: 'branch-new-input', autofocus: true, placeholder: 'branch name' })) : null,
			h('button', { id: 'show-new', onClick: function () { creating[1](true); } }, 'new'),
		),
		h('button', { id: 'effort-chip', ref: function (el) { eAnchor.current = el; } }, 'effort chip'),
		h(Popover, { anchor: eAnchor, open: effort[0], onClose: function () { effort[1](false); }, width: 264 },
			h(EffortSlider, { levels: ['low', 'medium', 'high'], value: 'medium', onChange: function () {}, autoFocus: true, onDone: function () {} })
		),
		h('button', { id: 'open-effort', onClick: function () { effort[1](true); } }, 'open effort')
	);
}
try {
	render(h(Holder), document.getElementById('app'));
	window.__open(true);
	assert(await until(function () {
		var i = document.getElementById('pop-search-input');
		return i && document.activeElement === i;
	}, 2500), 'the branch/model popover search input must be focused the moment the popover opens (active=' + (document.activeElement && document.activeElement.id) + ')');
	assert(await until(function () { return autofocusScanCount() >= 1; }, 2500), 'an open popover must hold the scan');
	document.getElementById('show-new').click();
	assert(await until(function () { return document.activeElement && document.activeElement.id === 'branch-new-input'; }, 2500), 'the new-branch form input must be focused the moment it appears inside the open popover');
	document.getElementById('open-effort').click();
	assert(await until(function () {
		var s = document.querySelector('.effort-track[autofocus]');
		return s && document.activeElement === s;
	}, 2500), 'the effort slider with autoFocus must take the keyboard when its popover opens');
	window.__open(false);
	window.__setEffort(false);
	assert(await until(function () { return autofocusScanCount() === 0; }, 3000), 'closing the popovers must release the scan back to zero');
	assert(window.__errors.length === 0, 'page errors: ' + window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed</p>');
} catch (err) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + '</p>');
}
`,
		);
		expect(text).toContain('id="ready">passed');
	},
	60000,
);

it.skipIf(skipIf)(
	"inline rename boxes and composer ask dialogs focus without holding the scan (sidebar, header shape, DialogBar)",
	async () => {
		const text = await runFixture(
			"autofocus-inline",
			`${prelude}
import {h,render} from '/vendor/preact.js';
import {useState, autofocusOnMount, autofocusScanCount} from '/js/ui.js';
import {Sidebar} from '/js/sidebar.js';
import {Composer} from '/js/composer.js';
import {set, setView} from '/js/store.js';
// Header rename replica (site 1, app.js:82): same markup plus the same autofocusOnMount ref the source now uses.
function HeaderReplica() {
	var st = useState(false);
	return st[0]
		? h('input', { class: 'field title-input', id: 'hdr-input', autofocus: true, ref: autofocusOnMount })
		: h('button', { class: 'title-btn', id: 'hdr-btn', onDblClick: function () { st[1](true); } }, 'Some chat');
}
try {
	setView({ lang: 'en', motion: 'off', chatMode: 'coding' });
	var list = [{ id: 'w000', name: 'proj-a', rootPath: 'C:/t/proj-a' }];
	var sessions = {};
	sessions['C:/t/proj-a'] = [{ id: 'c0-0', path: 'C:/t/proj-a/chat-0.jsonl', name: 'Chat one', firstMessage: '', messageCount: 3, modified: Date.now() }];
	set({ workspaces: { list: list, sessions: sessions, unbound: [], archived: [], errors: {}, loaded: true }, slots: [], activeSlot: null });
	set({ snap: { active: false, trust: { trusted: true }, flags: {}, queue: { steering: [], followUp: [] }, model: null, thinking: { levels: [] } }, queue: { steering: [], followUp: [] }, completion: false });
	render(h(Sidebar), document.getElementById('side'));
	render(h(Composer), document.getElementById('app'));
	await wait(400);
	assert(autofocusScanCount() === 0, 'idle sidebar+composer must hold no scan, got ' + autofocusScanCount());
	// Expand the workspace group so the chat rows mount (the seeded sessions list skips any fetch).
	var wsRow = document.querySelector('.ws-row');
	assert(wsRow, 'workspace row missing');
	wsRow.click();
	assert(await until(function () { return !!document.querySelector('.chat-row'); }, 2500), 'chat rows never appeared after expanding the group');
	// Site 16 (sidebar.js:96): double-click a chat row -> the title-edit box appears and must hold the keyboard.
	act(document.querySelector('.chat-row'), 'dblclick');
	assert(await until(function () {
		var i = document.querySelector('.chat-row .title-edit');
		return i && document.activeElement === i;
	}, 2500), 'the chat rename box must be focused the moment it appears (active=' + (document.activeElement && document.activeElement.className) + ')');
	assert(autofocusScanCount() === 0, 'an inline rename must not hold the scan');
	document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await wait(150);
	// Site 17 (sidebar.js:170): the workspace actions menu -> Rename -> the alias box appears and holds the keyboard.
	var more = document.querySelector('.ws .icon-btn[aria-label="Workspace actions"]');
	assert(more, 'workspace actions button missing');
	more.click();
	assert(await until(function () { return !!document.querySelector('.popover [role="menuitem"]'); }, 2500), 'workspace menu never opened');
	var rename = [...document.querySelectorAll('.popover [role="menuitem"]')].find(function (b) { return /Rename/.test(b.textContent); });
	assert(rename, 'Rename menu item missing');
	rename.click();
	assert(await until(function () {
		var i = document.querySelector('.ws-row .title-edit');
		return i && document.activeElement === i;
	}, 2500), 'the workspace rename box must be focused the moment it appears');
	document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await wait(200);
	assert(await until(function () { return autofocusScanCount() === 0; }, 2500), 'after closing every layer the count must settle at zero, got ' + autofocusScanCount());
	// Sites 6/7 (composer.js:97,98): an ask dialog of kind input/editor must land the keyboard on its field, no layer open.
	set({ dialogs: [{ id: 'd-in', kind: 'input', title: 'Type something', placeholder: 'value', initialValue: '' }] });
	assert(await until(function () {
		var i = document.querySelector('.dialog-input input');
		return i && document.activeElement === i;
	}, 2500), 'the ask-dialog input must take the keyboard when the dialog appears');
	assert(autofocusScanCount() === 0, 'an ask dialog input must not hold the scan');
	set({ dialogs: [{ id: 'd-ed', kind: 'editor', title: 'Edit this', initialValue: 'body text' }] });
	assert(await until(function () {
		var t = document.querySelector('.dialog-editor textarea');
		return t && document.activeElement === t;
	}, 2500), 'the ask-dialog editor textarea must take the keyboard when the dialog appears');
	set({ dialogs: [] });
	await wait(150);
	// Site 1 (app.js:82 shape, replica): double-clicking the title button focuses the title-input through the same ref.
	var holder = document.createElement('div');
	document.body.appendChild(holder);
	render(h(HeaderReplica), holder);
	act(holder.querySelector('.title-btn'), 'dblclick');
	assert(await until(function () {
		var i = document.getElementById('hdr-input');
		return i && document.activeElement === i;
	}, 2500), 'the header rename box must be focused the moment it appears');
	assert(autofocusScanCount() === 0, 'the inline header rename must not hold the scan either');
	assert(window.__errors.length === 0, 'page errors: ' + window.__errors.join(' / '));
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed</p>');
} catch (err) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">FAILED ' + err.message + '</p>');
}
`,
			true,
		);
		expect(text).toContain('id="ready">passed');
	},
	60000,
);
