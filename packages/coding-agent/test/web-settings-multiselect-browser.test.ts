import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { detectInstalledBrowsers, LocalBrowser } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

const longModelId =
	"openai/model-with-an-extraordinarily-long-identifier-that-must-remain-complete-in-the-cycling-scope";
const longUnknownPattern = "unlisted-provider/model-with-a-long-saved-pattern-not-in-the-current-catalog:high*";

const models = {
	providers: [
		{
			id: "openai",
			name: "OpenAI",
			models: [
				{ id: "gpt-4o", name: "GPT-4o" },
				{ id: "gpt-4o-mini", name: "GPT-4o mini" },
				{ id: longModelId, name: "Long model name" },
			],
		},
		{
			id: "anthropic",
			name: "Anthropic",
			models: [{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" }],
		},
	],
};

const items: Array<Record<string, unknown>> = [
	{
		id: "enabledModels",
		section: "Agent",
		label: "Model cycling scope",
		description:
			"Comma-separated model patterns used when cycling models (same format as --models, e.g. gpt-5*, provider/id:high). Empty cycles through every available model.",
		type: "text",
		value: "openai/gpt-4o, gpt-5*",
	},
	{
		id: "webSearch.enabled",
		section: "Tools",
		label: "Web search & fetch",
		description: "Enable the web_search and web_fetch tools.",
		type: "boolean",
		value: true,
	},
	{
		id: "webSearch.engines",
		section: "Tools",
		label: "Search engines",
		type: "multi",
		value: ["google", "bing"],
		options: [
			{ value: "google", label: "Google" },
			{ value: "bing", label: "Bing" },
			{ value: "duckduckgo", label: "DuckDuckGo" },
			{ value: "brave", label: "Brave" },
			{ value: "tavily", label: "Tavily API" },
		],
	},
];

it.skipIf(process.env.MYHARNESS_TARGETED_BROWSER_E2E !== "1" || !installed.length)(
	"renders searchable multi-select for model cycling scope and search engines in both locales",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-multiselect-"));
		const server = new WebHttpServer();
		const browser = new LocalBrowser({
			kind: installed.find((entry) => entry.kind === "chrome")?.kind ?? installed[0]!.kind,
			rootDir: join(root, "browser"),
		});
		const serverSaved: Array<{ id: string; value: unknown }> = [];
		try {
			for (const dir of ["js", "vendor", "css"]) {
				server.mount({ prefix: `/${dir}/`, directory: fileURLToPath(new URL(`../web/${dir}`, import.meta.url)) });
			}
			server.route("GET", "/api/settings", () => ({ items, menu: [], errors: [] }));
			server.route("GET", "/api/models", () => models);
			server.route("GET", "/api/state", () => ({ session: { id: "test" }, active: false }));
			const resetItems = () => {
				items[0]!.value = "openai/gpt-4o, gpt-5*";
				items[2]!.value = ["google", "bing"];
				return { ok: true };
			};
			server.route("POST", "/api/test/reset", resetItems);
			server.route("GET", "/api/test/reset", resetItems);
			server.route("POST", "/api/settings", ({ body }) => {
				const payload = body as { id: string; value: unknown };
				serverSaved.push(payload);
				const item = items.find((i) => i.id === payload.id);
				if (item) item.value = payload.value;
				return { ok: true, errors: [] };
			});
			server.mount({ prefix: "/test/", directory: root });
			writeFileSync(
				join(root, "index.html"),
				'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>',
			);
			writeFileSync(
				join(root, "test.js"),
				`
import { h, render } from '/vendor/preact.js';
import { SettingsModal } from '/js/overlays-settings.js';
import { loadSettings, set, setView } from '/js/store.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, msg) => { if (!ok) throw Error(msg); };

const saved = [];
const originalFetch = window.fetch;
window.fetch = async (...args) => {
	const [url, init] = args;
	if (typeof url === 'string' && url.includes('/api/settings') && init?.method === 'POST') {
		try {
			const body = JSON.parse(init.body);
			saved.push(body);
		} catch {}
	}
	return originalFetch(...args);
};

try {
	document.documentElement.dataset.motion = 'off';
	const app = document.getElementById('app');

	set({
		snap: { session: { id: 'test' }, active: false },
		models: ${JSON.stringify(models)},
		settings: { items: ${JSON.stringify(items)} },
		dialogs: [],
		runs: {},
		toolRuns: {},
		userBash: {},
		userBashOrder: [],
		items: []
	});

	for (const locale of ['zh-CN', 'en']) {
		const resetRes = await originalFetch('/api/test/reset', { method: 'POST', headers: { 'x-myharness-web': '1' } });
		assert(resetRes.ok, 'test reset failed with ' + resetRes.status);
		await loadSettings();
		render(null, app);
		setView({ lang: locale, settingsSection: 'agent' });
		render(h(SettingsModal, {}), app);
		await wait(250);

		// 3. Opening settings should not focus any input inside settings
		assert(document.activeElement !== document.querySelector('.settings-body input'), 'settings opened with input focused in ' + locale);

		// 1. Agent page: enabledModels
		const rows = [...document.querySelectorAll('.set-row')];
		const enabledRow = rows.find((r) =>
			r.querySelector('.set-label')?.textContent.includes(locale === 'zh-CN' ? '模型切换范围' : 'Model cycling scope')
		);
		assert(enabledRow, 'enabledModels row not found in ' + locale);

		const btn = enabledRow.querySelector('.set-multiselect-btn');
		assert(btn, 'multiselect button not found in ' + locale);

		// Collapsed state displays 2 tags
		let tags = [...btn.querySelectorAll('.set-multiselect-tag')];
		const currentSetting = (await (await originalFetch('/api/settings')).json()).items.find(i => i.id === 'enabledModels');
		assert(tags.length === 2, 'expected 2 tags initially in ' + locale + ', got ' + tags.length + ' server value: ' + JSON.stringify(currentSetting));
		assert(tags[0].textContent.includes('openai/gpt-4o'), 'tag 0 missing openai/gpt-4o');
		assert(tags[1].textContent.includes('gpt-5*'), 'tag 1 missing gpt-5*');
		const bRect = btn.getBoundingClientRect();
		assert(bRect.height >= 24 && bRect.width >= 100, 'multiselect button dimension abnormal: ' + JSON.stringify(bRect));
		const tag0Rect = tags[0].getBoundingClientRect();
		assert(tag0Rect.height >= 16 && tag0Rect.width >= 20, 'tag dimension abnormal: ' + JSON.stringify(tag0Rect));

		// Click to open popover
		btn.click();
		await wait(150);

		let popover = document.querySelector('.popover.set-multiselect-pop');
		assert(popover, 'popover not opened in ' + locale);

		// Check popover is in viewport (not clipped)
		const pRect = popover.getBoundingClientRect();
		assert(
			pRect.top >= 0 && pRect.left >= 0 && pRect.bottom <= window.innerHeight && pRect.right <= window.innerWidth,
			'popover clipped by viewport: ' + JSON.stringify(pRect)
		);
		assert(pRect.width >= 160 && pRect.height >= 80, 'popover dimensions abnormal: ' + JSON.stringify(pRect));

		// List shows stubbed models + gpt-5*
		let opts = [...popover.querySelectorAll('[role="option"]')];
		const gpt5Option = opts.find((o) => o.textContent.includes('gpt-5*'));
		assert(gpt5Option, 'gpt-5* unknown option not found in list in ' + locale);
		assert(gpt5Option.getAttribute('aria-selected') === 'true', 'gpt-5* not checked');
		assert(
			gpt5Option.textContent.includes(locale === 'zh-CN' ? '已选（不在当前模型列表中）' : 'Selected (not in current model list)'),
			'missing unknown hint in ' + locale
		);

		const gpt4oOption = opts.find((o) => o.textContent.includes('openai/gpt-4o'));
		assert(gpt4oOption && gpt4oOption.getAttribute('aria-selected') === 'true', 'openai/gpt-4o not checked');

		// Filter by search word
		const searchInput = popover.querySelector('.pop-search input');
		assert(searchInput, 'search input not found in ' + locale);
		searchInput.focus();
		searchInput.value = 'sonnet';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		await wait(100);

		opts = [...popover.querySelectorAll('[role="option"]')];
		assert(opts.every((o) => o.textContent.toLowerCase().includes('sonnet')), 'search filter failed in ' + locale);

		// Check claude-3-5-sonnet
		const sonnetOption = opts.find((o) => o.textContent.includes('claude-3-5-sonnet'));
		assert(sonnetOption, 'sonnet option not found in ' + locale);
		sonnetOption.click();
		await wait(150);

		// Check saved POST payload: comma-space separated string
		let lastSaved = saved[saved.length - 1];
		assert(lastSaved?.id === 'enabledModels', 'save not triggered for enabledModels');
		assert(
			lastSaved.value === 'openai/gpt-4o, gpt-5*, anthropic/claude-3-5-sonnet',
			'incorrect payload after adding sonnet: ' + lastSaved.value
		);

		// Click × on gpt-5* tag to delete it
		const gpt5Tag = [...btn.querySelectorAll('.set-multiselect-tag')].find((t) => t.textContent.includes('gpt-5*'));
		assert(gpt5Tag, 'gpt-5* tag not found on button');
		const removeBtn = gpt5Tag.querySelector('.set-multiselect-tag-remove');
		removeBtn.click();
		await wait(150);

		lastSaved = saved[saved.length - 1];
		assert(lastSaved?.id === 'enabledModels', 'save not triggered after delete');
		assert(
			lastSaved.value === 'openai/gpt-4o, anthropic/claude-3-5-sonnet',
			'incorrect payload after deleting gpt-5*: ' + lastSaved.value
		);

		// allowCustom: Type provider/foo:high and press Enter
		searchInput.focus();
		searchInput.value = 'provider/foo:high';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		await wait(100);

		searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await wait(150);

		lastSaved = saved[saved.length - 1];
		assert(
			lastSaved.value === 'openai/gpt-4o, anthropic/claude-3-5-sonnet, provider/foo:high',
			'incorrect payload after adding custom: ' + lastSaved.value
		);

		// Clear all tags
		while (btn.querySelectorAll('.set-multiselect-tag-remove').length > 0) {
			btn.querySelector('.set-multiselect-tag-remove').click();
			await wait(100);
		}

		lastSaved = saved[saved.length - 1];
		assert(lastSaved.value === '', 'payload not empty after clearing all tags: ' + lastSaved.value);
		const placeholderText = btn.textContent;
		assert(
			placeholderText.includes(locale === 'zh-CN' ? '全部模型' : 'All models'),
			'placeholder missing in ' + locale + ': ' + placeholderText
		);

		// Esc closes popover
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await wait(150);
		assert(!document.querySelector('.popover.set-multiselect-pop:not(.closing)'), 'popover not closed on Esc in ' + locale);

		// Long known IDs and saved unknown patterns must remain complete in both the list and its chips.
		btn.click();
		await wait(150);
		popover = document.querySelector('.popover.set-multiselect-pop:not(.closing)');
		const longOption = [...popover.querySelectorAll('[role="option"]')].find((o) => o.title === ${JSON.stringify(longModelId)});
		assert(longOption, 'long model option missing in ' + locale);
		const longOptionLabel = longOption.querySelector('.set-multiselect-option-label');
		assert(longOptionLabel.textContent === ${JSON.stringify(longModelId)}, 'long option ID changed');
		assert(longOptionLabel.scrollWidth <= longOptionLabel.clientWidth + 1, 'long option ID truncated in ' + locale);
		longOption.click();
		await wait(150);
		const longSearch = popover.querySelector('.pop-search input');
		longSearch.value = ${JSON.stringify(longUnknownPattern)};
		longSearch.dispatchEvent(new Event('input', { bubbles: true }));
		await wait(100);
		longSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await wait(150);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await wait(150);
		// Re-open persisted settings; neither the known ID nor the unknown pattern can be lost.
		setView({ settingsSection: 'search' });
		await loadSettings();
		setView({ settingsSection: 'agent' });
		await wait(150);
		const longRow = [...document.querySelectorAll('.set-row')].find((r) =>
			r.querySelector('.set-label')?.textContent.includes(locale === 'zh-CN' ? '模型切换范围' : 'Model cycling scope'));
		const longBtn = longRow.querySelector('.set-multiselect-btn');
		const assertCompleteChips = () => {
			const labels = [...longBtn.querySelectorAll('.set-multiselect-tag-label')];
			assert(labels.length === 2, 'long saved selections lost: ' + labels.length);
			for (const id of [${JSON.stringify(longModelId)}, ${JSON.stringify(longUnknownPattern)}]) {
				const label = labels.find((el) => el.textContent === id);
				assert(label, 'saved long ID missing: ' + id);
				assert(label.scrollWidth <= label.clientWidth + 1, 'long chip ID truncated: ' + id);
			}
			assert(longBtn.scrollWidth <= longBtn.clientWidth + 1, 'long ID chips overflow sideways');
		};
		assertCompleteChips();
		const longGrid = document.querySelector('.settings');
		longGrid.style.gridTemplateColumns = '0px minmax(0,280px)';
		await wait(150);
		assertCompleteChips();
		longGrid.style.gridTemplateColumns = '';
		await wait(100);
		longBtn.querySelector('.set-multiselect-tag-remove').click();
		await wait(150);
		assert(saved[saved.length - 1]?.value === ${JSON.stringify(longUnknownPattern)}, 'long chip removal changed persistence');

		// 2. Search page: Search engines (C.7)
		setView({ settingsSection: 'search' });
		await wait(150);

		const searchRows = [...document.querySelectorAll('.set-row')];
		const enginesRow = searchRows.find((r) =>
			r.querySelector('.set-label')?.textContent.includes(locale === 'zh-CN' ? '搜索引擎' : 'Search engines')
		);
		assert(enginesRow, 'engines row not found in ' + locale);

		const enginesBtn = enginesRow.querySelector('.set-multiselect-btn');
		assert(enginesBtn, 'engines multiselect button not found in ' + locale);

		// Collapsed state shows chips (tags), not the old comma summary: two chips Google + Bing, each with its own ×
		assert(enginesBtn.classList.contains('tags'), 'engines control is not in tags mode: ' + enginesBtn.className);
		assert(!enginesBtn.textContent.includes('Google, Bing'), 'engines still renders comma summary text');
		let engineTags = [...enginesBtn.querySelectorAll('.set-multiselect-tag')];
		assert(engineTags.length === 2, 'expected 2 engine chips, got ' + engineTags.length + ': ' + enginesBtn.textContent);
		const chipLabel = (chip) => chip.querySelector('.set-multiselect-tag-label')?.textContent || '';
		assert(chipLabel(engineTags[0]) === 'Google', 'engine chip 0 label: ' + chipLabel(engineTags[0]));
		assert(chipLabel(engineTags[1]) === 'Bing', 'engine chip 1 label: ' + chipLabel(engineTags[1]));
		for (const chip of engineTags) {
			const rm = chip.querySelector('.set-multiselect-tag-remove');
			assert(rm && !rm.disabled, 'engine chip missing an enabled × button: ' + chipLabel(chip));
			assert((rm.getAttribute('aria-label') || '').includes(chipLabel(chip)), 'chip × aria-label: ' + rm.getAttribute('aria-label'));
		}

		// Removing Bing via its chip × submits a string[] with the remaining engine
		const savedCountBefore = saved.length;
		engineTags[1].querySelector('.set-multiselect-tag-remove').click();
		await wait(150);
		assert(saved.length === savedCountBefore + 1, 'chip × removal did not save');
		lastSaved = saved[saved.length - 1];
		assert(Array.isArray(lastSaved.value) && JSON.stringify(lastSaved.value) === JSON.stringify(['google']),
			'chip × removal payload not ["google"]: ' + JSON.stringify(lastSaved.value));

		// Open popover
		enginesBtn.click();
		await wait(150);

		let enginesPop = document.querySelector('.popover.set-multiselect-pop');
		assert(enginesPop, 'engines popover not opened in ' + locale);

		// Re-check Bing from the popover: order is preserved by appending at the end
		const bingReAdd = [...enginesPop.querySelectorAll('[role="option"]')].find((o) => o.title === 'bing');
		bingReAdd.click();
		await wait(150);
		lastSaved = saved[saved.length - 1];
		assert(JSON.stringify(lastSaved.value) === JSON.stringify(['google', 'bing']),
			'readding Bing did not restore the payload: ' + JSON.stringify(lastSaved.value));

		// Check DuckDuckGo
		const ddgOpt = [...enginesPop.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('DuckDuckGo'));
		assert(ddgOpt, 'DuckDuckGo option not found');
		ddgOpt.click();
		await wait(150);

		lastSaved = saved[saved.length - 1];
		assert(lastSaved?.id === 'webSearch.engines', 'save not triggered for engines');
		assert(Array.isArray(lastSaved.value), 'engines payload is not array');
		assert(
			JSON.stringify(lastSaved.value) === JSON.stringify(['google', 'bing', 'duckduckgo']),
			'engines order mismatch: ' + JSON.stringify(lastSaved.value)
		);

		// Deselect down to only 1: uncheck DuckDuckGo, then uncheck Bing
		ddgOpt.click();
		await wait(150);

		const bingOpt = [...enginesPop.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('Bing'));
		bingOpt.click();
		await wait(150);

		lastSaved = saved[saved.length - 1];
		assert(JSON.stringify(lastSaved.value) === JSON.stringify(['google']), 'only google should remain: ' + JSON.stringify(lastSaved.value));

		// Try to uncheck google (the last one)
		const googleOpt = [...enginesPop.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('Google'));
		googleOpt.click();
		await wait(150);

		lastSaved = saved[saved.length - 1];
		assert(JSON.stringify(lastSaved.value) === JSON.stringify(['google']), 'last engine cannot be deselected');

		// Search br: filters to plain Brave only (the Brave Search API option was removed)
		const engSearch = enginesPop.querySelector('.pop-search input');
		engSearch.focus();
		engSearch.value = 'br';
		engSearch.dispatchEvent(new Event('input', { bubbles: true }));
		await wait(100);

		const brFiltered = [...enginesPop.querySelectorAll('[role="option"]')];
		assert(brFiltered.length === 1, 'expected 1 Brave option, got ' + brFiltered.length);
		assert(!enginesPop.textContent.includes('Brave Search API') && !enginesPop.textContent.includes('Brave 搜索 API'), 'Brave Search API option still listed');

		// Close
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await wait(150);

		// allowEmpty: false — with only Google left its chip × is disabled and cannot remove the last engine
		engineTags = [...enginesBtn.querySelectorAll('.set-multiselect-tag')];
		assert(engineTags.length === 1, 'expected the single Google chip, got ' + engineTags.length);
		assert(chipLabel(engineTags[0]) === 'Google', 'last chip label: ' + chipLabel(engineTags[0]));
		const lastRemove = engineTags[0].querySelector('.set-multiselect-tag-remove');
		assert(lastRemove.disabled, 'last chip × should be disabled when allowEmpty is false');
		assert(lastRemove.getAttribute('aria-label')?.includes('Google'), 'disabled × lost its aria-label');
		const savedCountAtLast = saved.length;
		lastRemove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await wait(150);
		assert(saved.length === savedCountAtLast, 'disabled last × must not save');
		assert(enginesBtn.querySelectorAll('.set-multiselect-tag').length === 1, 'last chip was removed via the × path');

		// Select all five engines from the popover
		enginesBtn.click();
		await wait(150);
		enginesPop = document.querySelector('.popover.set-multiselect-pop');
		assert(enginesPop, 'engines popover not reopened in ' + locale);
		for (const val of ['bing', 'duckduckgo', 'brave', 'tavily']) {
			const opt = [...enginesPop.querySelectorAll('[role="option"]')].find((o) => o.title === val);
			assert(opt, 'missing engine option ' + val + ' in ' + locale);
			opt.click();
			await wait(100);
		}
		lastSaved = saved[saved.length - 1];
		assert(
			JSON.stringify(lastSaved.value) === JSON.stringify(['google', 'bing', 'duckduckgo', 'brave', 'tavily']),
			'all-five payload mismatch: ' + JSON.stringify(lastSaved.value)
		);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await wait(150);

		// Five chips: every name complete (scrollWidth <= clientWidth), each chip 22px tall, no horizontal overflow
		engineTags = [...enginesBtn.querySelectorAll('.set-multiselect-tag')];
		assert(engineTags.length === 5, 'expected 5 engine chips, got ' + engineTags.length);
		for (const chip of engineTags) {
			const lab = chip.querySelector('.set-multiselect-tag-label');
			assert(lab.scrollWidth <= lab.clientWidth + 1, 'engine name truncated: ' + lab.textContent);
			assert(chip.scrollWidth <= chip.clientWidth + 1, 'chip content overflow: ' + lab.textContent);
			const chipH = chip.getBoundingClientRect().height;
			assert(Math.abs(chipH - 22) < 0.6, 'chip is not 22px tall: ' + chipH);
		}
		const tagsBox = enginesBtn.querySelector('.set-multiselect-tags');
		assert(
			tagsBox.scrollWidth <= tagsBox.clientWidth + 1,
			'chips row overflows horizontally: ' + tagsBox.scrollWidth + ' > ' + tagsBox.clientWidth
		);

		// Narrow the card (still wide enough for the longest chip "DuckDuckGo"): the five chips wrap into
		// at least two rows, names stay complete, the button grows, nothing overflows sideways
		const flatBtnH = enginesBtn.getBoundingClientRect().height;
		const settingsGrid = document.querySelector('.settings');
		settingsGrid.style.gridTemplateColumns = '0px minmax(0,280px)';
		await wait(150);
		const chipRows = [...new Set(engineTags.map((c) => Math.round(c.getBoundingClientRect().y)))];
		assert(chipRows.length >= 2, 'five chips did not wrap into rows: tops=' + JSON.stringify(chipRows));
		const wrappedBtnH = enginesBtn.getBoundingClientRect().height;
		assert(wrappedBtnH >= flatBtnH + 26, 'button height did not grow by a chip row on wrap: ' + wrappedBtnH + ' vs ' + flatBtnH);
		for (const chip of engineTags) {
			const lab = chip.querySelector('.set-multiselect-tag-label');
			assert(lab.scrollWidth <= lab.clientWidth + 1, 'engine name truncated when wrapped: ' + lab.textContent);
			assert(chip.getBoundingClientRect().height >= 22 && chip.getBoundingClientRect().height <= 23, 'chip height distorted on wrap: ' + chip.getBoundingClientRect().height);
		}
		assert(
			tagsBox.scrollWidth <= tagsBox.clientWidth + 1,
			'wrapped chips overflow horizontally: ' + tagsBox.scrollWidth + ' > ' + tagsBox.clientWidth
		);
		settingsGrid.style.gridTemplateColumns = '';
		await wait(100);
	}

	document.body.insertAdjacentHTML('beforeend', '<p id="ready">passed</p>');
} catch (err) {
	document.body.insertAdjacentHTML('beforeend', '<p id="ready">' + err.message + '</p>');
}
`,
			);
			server.setIndexFile(join(root, "index.html"));
			const { port } = await server.listen(0);
			const page = await browser.solveChallenge({
				url: `http://127.0.0.1:${port}/`,
				readySelector: "#ready",
				label: "Settings searchable multi-select test",
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
