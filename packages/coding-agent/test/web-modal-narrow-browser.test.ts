import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { launchChromium } from "../src/tools/web-search/browser/chromium.ts";
import { detectInstalledBrowsers } from "../src/tools/web-search/browser/firefox.ts";

const installed = detectInstalledBrowsers();

// The settings dialog (ui.js Modal, width 900) on a narrow viewport (W216): the dialog must stay centered with at
// least 24 px of margin on each side instead of spilling past the right edge, and on a wide viewport it must keep
// its exact 900 px width. The fixture mounts the real Modal at the real settings width inside a .scrim (as the app
// does), resizes through CDP device metrics, and reads the dialog rect after the entrance animation settles.
const indexHtml =
	'<!doctype html><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/overlays.css"><div id="app"></div><script type="module" src="/test/test.js"></script>';

const testJs = `
import { h, render } from '/vendor/preact.js';
import { Modal } from '/js/ui.js';

var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function NarrowModalApp() {
	return h(Modal, { title: 'Settings', class: 'settings-modal', width: 900, onClose: function () {}, focusInput: false },
		h('div', { class: 'settings' },
			h('nav', { class: 'settings-nav' }, ['Appearance', 'Agent', 'Web search', 'Network & shell'].map(label => h('button', {}, label))),
			h('div', { class: 'settings-body' }, h('section', { class: 'set-card' }, h('div', { class: 'set-card-body' },
				h('div', { class: 'set-row' },
					h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, 'Concurrent downloads'), h('span', { class: 'set-desc' }, 'Keep the setting readable on a narrow desktop viewport.')),
					h('div', { class: 'set-control' }, h('input', { id: 'narrow-input', class: 'field num', type: 'number', value: 4 }))))))));
}

render(h(NarrowModalApp, {}), document.getElementById('app'));
document.documentElement.dataset.theme = 'dark';

window.__measureModal = async function () {
	var el = document.querySelector('.modal.settings-modal');
	if (!el) return JSON.stringify({ error: 'settings modal never mounted' });
	// The entrance animation (dialog-in, --t-pop) carries a scale; measure at rest.
	await wait(300);
	var r = el.getBoundingClientRect();
	var scrim = el.closest('.scrim');
	var cs = getComputedStyle(el);
	return JSON.stringify({
		vw: window.innerWidth,
		left: Math.round(r.left * 10) / 10,
		width: Math.round(r.width * 10) / 10,
		right: Math.round(r.right * 10) / 10,
		scrim: !!scrim,
		anim: cs.animationName,
		textWidth: document.querySelector('.set-text').getBoundingClientRect().width,
		controlWidth: document.querySelector('.set-control').getBoundingClientRect().width,
		cardOverflow: document.querySelector('.set-card').scrollWidth > document.querySelector('.set-card').clientWidth + 1,
		numberWidth: document.getElementById('narrow-input').getBoundingClientRect().width,
	});
};
document.body.insertAdjacentHTML('beforeend', '<p id="ready">narrow-ready</p>');
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
	"the settings dialog stays centered with 24px margins on narrow viewports and keeps 900px on wide ones",
	async () => {
		const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR || tmpdir(), "myharness-modal-narrow-"));
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
			const created = await bridge.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
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
						{ expression: "String(!!window.__measureModal)", returnByValue: true },
						sessionId,
					)
					.catch((): Record<string, unknown> => ({}));
				ready = (reply.result as { value?: string } | undefined)?.value === "true";
				if (!ready) await new Promise((r) => setTimeout(r, 200));
			}
			expect(ready, "the narrow fixture page never came up").toBe(true);
			const measure = async (width: number, height: number) => {
				await bridge.send(
					"Emulation.setDeviceMetricsOverride",
					{ width, height, deviceScaleFactor: 1, mobile: false },
					sessionId,
				);
				await new Promise((r) => setTimeout(r, 400));
				const evaluated = await bridge.send(
					"Runtime.evaluate",
					{ expression: "window.__measureModal()", awaitPromise: true, returnByValue: true },
					sessionId,
				);
				return JSON.parse(String((evaluated.result as { value?: string } | undefined)?.value ?? "{}"));
			};
			// 700x600: the dialog clamps to vw - 48 and centers with 24 px on each side.
			const small = await measure(700, 600);
			expect(small.error, `narrow measure must run: ${String(small.error)}`).toBeUndefined();
			expect(small.vw, "the emulated viewport must be 700 px wide").toBe(700);
			expect(small.scrim, "the modal stays inside a .scrim").toBe(true);
			expect(small.anim, "the entrance animation keeps running dialog-in").toBe("dialog-in");
			expect(small.left, `left margin must be >= 24, got ${small.left}`).toBeGreaterThanOrEqual(24 - 0.5);
			expect(small.right, `right edge must be <= vw - 24, got ${small.right}`).toBeLessThanOrEqual(700 - 24 + 0.5);
			expect(
				Math.abs(small.left - (700 - small.right)),
				`margins must be symmetric within 2 px: left=${small.left} right=${700 - small.right}`,
			).toBeLessThanOrEqual(2);
			expect(small.width, `dialog width must be 652 at 700 px viewport, got ${small.width}`).toBeCloseTo(652, 0);
			// 900x700: 852 px wide, still symmetric with 24 px margins.
			const mid = await measure(900, 700);
			expect(mid.error, `narrow measure must run: ${String(mid.error)}`).toBeUndefined();
			expect(mid.left, `left margin must be >= 24, got ${mid.left}`).toBeGreaterThanOrEqual(24 - 0.5);
			expect(mid.right, `right edge must be <= vw - 24, got ${mid.right}`).toBeLessThanOrEqual(900 - 24 + 0.5);
			expect(
				Math.abs(mid.left - (900 - mid.right)),
				`margins must be symmetric within 2 px: left=${mid.left} right=${900 - mid.right}`,
			).toBeLessThanOrEqual(2);
			expect(mid.width, `dialog width must be 852 at 900 px viewport, got ${mid.width}`).toBeCloseTo(852, 0);
			// The full settings body must remain readable too, not merely its outer dialog rectangle.
			const narrow = await measure(640, 820);
			expect(narrow.textWidth, "setting text needs room beyond one or two characters").toBeGreaterThanOrEqual(120);
			expect(narrow.cardOverflow, "the settings card must not overflow horizontally").toBe(false);
			expect(narrow.numberWidth, "compact numeric inputs keep their 80px contract").toBeCloseTo(80, 0);
			// 1440x900: the dialog keeps its exact 900 px design width, centered as before.
			const wide = await measure(1440, 900);
			expect(wide.error, `wide measure must run: ${String(wide.error)}`).toBeUndefined();
			expect(wide.width, `dialog width must stay 900 at 1440 px viewport, got ${wide.width}`).toBeCloseTo(900, 0);
			expect(
				Math.abs(wide.left - (1440 - wide.right)),
				`wide margins must stay symmetric: left=${wide.left} right=${1440 - wide.right}`,
			).toBeLessThanOrEqual(2);
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
