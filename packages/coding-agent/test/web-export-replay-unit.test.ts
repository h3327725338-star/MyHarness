import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReplayHtml } from "../src/exports/html/replay/build.ts";
import { SessionManager } from "../src/session/manager/index.ts";

// Mock browser-only imports for Node testing environment
vi.mock("../web/js/ui.js", () => ({
	html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		type: "vnode",
		strings: Array.from(strings),
		values,
	}),
	Icon: (props?: { name?: string; size?: number }) => ({ type: "icon", name: props?.name, size: props?.size }),
}));

vi.mock("/vendor/preact-hooks.js", () => ({
	useLayoutEffect: () => {},
	useRef: (init: unknown) => ({ current: init }),
	useState: (init: unknown) => [init, () => {}],
}));

const { ExportHeaderDownload, ExportSidebarFoot, exportReadOnly, getEventSourceFactory, getFetch } = (await import(
	new URL("../web/js/export-mode.js", import.meta.url).href
)) as any;
const { api } = (await import(new URL("../web/js/store.js", import.meta.url).href)) as any;
const { loadPrefs } = (await import(new URL("../web/js/util.js", import.meta.url).href)) as any;

declare global {
	// eslint-disable-next-line no-var
	var __MYHARNESS_EXPORT__: any;
}

describe("W21: Frontend read-only replay hooks", () => {
	const originalGlobalExport = globalThis.__MYHARNESS_EXPORT__;
	const originalFetch = globalThis.fetch;
	const originalEventSource = (globalThis as any).EventSource;
	const originalLocalStorage = globalThis.localStorage;

	beforeEach(() => {
		delete (globalThis as any).__MYHARNESS_EXPORT__;
	});

	afterEach(() => {
		if (originalGlobalExport !== undefined) {
			globalThis.__MYHARNESS_EXPORT__ = originalGlobalExport;
		} else {
			delete (globalThis as any).__MYHARNESS_EXPORT__;
		}
		globalThis.fetch = originalFetch;
		(globalThis as any).EventSource = originalEventSource;
		(globalThis as any).localStorage = originalLocalStorage;
	});

	describe("exportReadOnly()", () => {
		it("returns false when __MYHARNESS_EXPORT__ is not set", () => {
			expect(exportReadOnly()).toBe(false);
		});

		it("returns true when __MYHARNESS_EXPORT__ is set", () => {
			globalThis.__MYHARNESS_EXPORT__ = { version: 1 };
			expect(exportReadOnly()).toBe(true);
		});
	});

	describe("getFetch()", () => {
		it("returns native fetch when __MYHARNESS_EXPORT__ is not set", () => {
			const dummyFetch = vi.fn();
			globalThis.fetch = dummyFetch as any;
			expect(getFetch()).toBe(dummyFetch);
		});

		it("returns injected fetch when __MYHARNESS_EXPORT__.fetch is provided", () => {
			const customFetch = vi.fn();
			globalThis.__MYHARNESS_EXPORT__ = { fetch: customFetch };
			expect(getFetch()).toBe(customFetch);
		});

		it("falls back to global fetch when __MYHARNESS_EXPORT__.fetch is not a function", () => {
			const dummyFetch = vi.fn();
			globalThis.fetch = dummyFetch as any;
			globalThis.__MYHARNESS_EXPORT__ = { fetch: null };
			expect(getFetch()).toBe(dummyFetch);
		});
	});

	describe("getEventSourceFactory()", () => {
		it("returns native EventSource when __MYHARNESS_EXPORT__ is not set", () => {
			const dummyES = (() => {}) as any;
			(globalThis as any).EventSource = dummyES;
			expect(getEventSourceFactory()).toBe(dummyES);
		});

		it("returns injected createEventSource when provided", () => {
			const customES = vi.fn();
			globalThis.__MYHARNESS_EXPORT__ = { createEventSource: customES };
			expect(getEventSourceFactory()).toBe(customES);
		});
	});

	describe("api() in normal vs read-only mode", () => {
		it("normal mode: executes requests via native fetch and returns parsed json", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ ok: true, data: "hello" }),
			});
			globalThis.fetch = mockFetch as any;

			const result = await api("/api/test");
			expect(result).toEqual({ ok: true, data: "hello" });
			expect(mockFetch).toHaveBeenCalledWith(
				"/api/test",
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({ "x-myharness-web": "1" }),
				}),
			);
		});

		it("normal mode: throws 'Cannot reach the MyHarness server.' on network failure", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused")) as any;

			await expect(api("/api/test")).rejects.toThrow("Cannot reach the MyHarness server.");
		});

		it("read-only mode: routes through injected fetch", async () => {
			const injectedFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ bootstrapped: true }),
			});
			globalThis.__MYHARNESS_EXPORT__ = { fetch: injectedFetch };

			const result = await api("/api/boot");
			expect(result).toEqual({ bootstrapped: true });
			expect(injectedFetch).toHaveBeenCalledWith(
				"/api/boot",
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({ "x-myharness-web": "1" }),
				}),
			);
		});

		it("read-only mode: rejects write requests with 'This is a read-only copy' message", async () => {
			const injectedFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 405,
				text: async () => JSON.stringify({ error: "Read only" }),
			});
			globalThis.__MYHARNESS_EXPORT__ = { fetch: injectedFetch };

			await expect(api("/api/messages", { method: "POST", body: { text: "hi" } })).rejects.toThrow(
				"This is a read-only copy: the conversation cannot be changed.",
			);
		});

		it("read-only mode: throws read-only message when fetch throws", async () => {
			const injectedFetch = vi.fn().mockRejectedValue(new Error("Offline network failed"));
			globalThis.__MYHARNESS_EXPORT__ = { fetch: injectedFetch };

			await expect(api("/api/messages", { method: "POST" })).rejects.toThrow(
				"This is a read-only copy: the conversation cannot be changed.",
			);
		});
	});

	describe("loadPrefs() in normal vs read-only mode", () => {
		it("normal mode: loads prefs from localStorage", () => {
			const stored = { theme: "forest", lang: "en" };
			(globalThis as any).localStorage = {
				getItem: vi.fn().mockReturnValue(JSON.stringify(stored)),
			};

			const loaded = loadPrefs();
			expect(loaded).toEqual(stored);
		});

		it("read-only mode: prefers __MYHARNESS_EXPORT__.prefs", () => {
			const exportPrefs = { theme: "amber", lang: "zh-CN", motion: "reduced" };
			globalThis.__MYHARNESS_EXPORT__ = { prefs: exportPrefs };
			(globalThis as any).localStorage = {
				getItem: vi.fn().mockReturnValue(JSON.stringify({ theme: "classic" })),
			};

			const loaded = loadPrefs();
			expect(loaded).toEqual(exportPrefs);
		});
	});

	describe("ExportSidebarFoot component", () => {
		it("returns null when __MYHARNESS_EXPORT__ is not set (live mode renders no such area)", () => {
			expect(ExportSidebarFoot()).toBeNull();
			expect(ExportHeaderDownload()).toBeNull();
		});

		it("renders badge, download button and source/time lines from the boot export fields", () => {
			const downloadFn = vi.fn();
			globalThis.__MYHARNESS_EXPORT__ = {
				export: {
					sourceName: "small.jsonl",
					sourcePath: "C:\\lab\\sessions\\small.jsonl",
					exportedAt: "2026-10-11T04:00:00.000Z",
				},
				exportedAt: "2026-10-11T04:00:00.000Z",
				downloadJsonl: downloadFn,
			};

			const vnode = ExportSidebarFoot() as any;
			expect(vnode).toBeTruthy();
			expect(vnode.type).toBe("vnode");
			// Structure (static class names live in the template strings): badge row, one button, two small lines.
			const markup = vnode.strings.join("");
			expect(markup).toContain("export-side-foot");
			expect(markup).toContain("export-side-badge");
			expect(markup).toContain("export-side-download");
			expect(markup.match(/class="export-side-line/g)?.length).toBe(2);
			// Display text is composed with t() from the raw fields (English mode returns the keys).
			expect(vnode.values).toContain("Read-only copy");
			expect(vnode.values).toContain("Download raw JSONL");
			expect(vnode.values.some((v: unknown) => typeof v === "string" && v.includes("small.jsonl"))).toBe(true);
			expect(vnode.values.some((v: unknown) => typeof v === "string" && v.startsWith("Exported at "))).toBe(true);
			// The whole block's title carries the full source path as a bound attribute value, never baked into markup.
			expect(vnode.values).toContain("C:\\lab\\sessions\\small.jsonl");
			expect(markup).not.toContain("C:\\lab\\sessions\\small.jsonl");

			// Clicking the download button triggers runtime.downloadJsonl.
			const click = vnode.values.find(
				(v: unknown) => typeof v === "function" && (v as any).name !== "Icon",
			) as () => void;
			expect(click).toBeTruthy();
			click();
			expect(downloadFn).toHaveBeenCalledTimes(1);
		});

		it("passes a hostile source path to title as a value, not interpolated into markup", () => {
			const evil = 'C:\\a\\b"><img src=x onerror=1>\\x.jsonl';
			globalThis.__MYHARNESS_EXPORT__ = {
				export: { sourceName: "x.jsonl", sourcePath: evil, exportedAt: "2026-10-11T04:00:00.000Z" },
				downloadJsonl: vi.fn(),
			};
			const vnode = ExportSidebarFoot() as any;
			const markup = vnode.strings.join("");
			expect(markup).not.toContain(evil);
			expect(markup).not.toContain('"><img');
			expect(vnode.values).toContain(evil);
		});

		it("header download button shares the sidebar aria-label and triggers the same callback", () => {
			const downloadFn = vi.fn();
			globalThis.__MYHARNESS_EXPORT__ = {
				export: {
					sourceName: "small.jsonl",
					sourcePath: "C:\\lab\\small.jsonl",
					exportedAt: "2026-10-11T04:00:00.000Z",
				},
				downloadJsonl: downloadFn,
			};
			const foot = ExportSidebarFoot() as any;
			const head = ExportHeaderDownload() as any;
			expect(head.strings.join("")).toContain("export-header-download");
			expect(head.values).toContain("Download raw JSONL");
			const click = head.values.find(
				(v: unknown) => typeof v === "function" && (v as any).name !== "Icon",
			) as () => void;
			expect(click).toBeTruthy();
			click();
			expect(downloadFn).toHaveBeenCalledTimes(1);
			// Same aria-label/title string as the sidebar button (title, aria-label and label text).
			expect(foot.values.filter((v: unknown) => v === "Download raw JSONL").length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("W123: sidebar mounting and body cleanup (source level)", () => {
		it("sidebar mounts the export area between .sidebar-scroll and .sidebar-foot, export mode only", () => {
			const src = readFileSync(new URL("../web/js/sidebar.js", import.meta.url), "utf8");
			const scrollIdx = src.indexOf('class="sidebar-scroll"');
			const mount = /exportReadOnly\(\) \? html`<\$\{ExportSidebarFoot\} \/>` : null/.exec(src);
			const footIdx = src.indexOf('class="sidebar-foot"');
			expect(scrollIdx).toBeGreaterThanOrEqual(0);
			expect(mount).not.toBeNull();
			expect(mount!.index).toBeGreaterThan(scrollIdx);
			expect(footIdx).toBeGreaterThan(mount!.index);
		});

		it("app.js keeps no ExportBar: nothing renders at the main bottom in read-only mode", () => {
			const src = readFileSync(new URL("../web/js/app.js", import.meta.url), "utf8");
			expect(src).not.toContain("ExportBar");
			expect(src).not.toContain("export-bar");
			expect(src).toMatch(/exportReadOnly\(\) \? null : html`<\$\{Composer\} \/>`/);
			// The accepted top badge stays; the collapsed-state header button appears only while the sidebar is closed.
			expect(src).toContain('class="export-top-badge"');
			expect(src).toMatch(/exportReadOnly\(\) && !sidebarOpen \? html`<\$\{ExportHeaderDownload\} \/>` : null/);
		});
	});

	describe("data-export-offline attributes presence", () => {
		it("has data-export-offline in app.js for Changes, Files, Terminal", () => {
			const appSrc = readFileSync(new URL("../web/js/app.js", import.meta.url), "utf8");
			expect(appSrc).toContain('["changes", "files", "terminal"].includes(tab)');
			expect(appSrc).toContain("data-export-offline");
		});

		it("has data-export-offline in sidebar.js for New chat and Add workspace", () => {
			const sidebarSrc = readFileSync(new URL("../web/js/sidebar.js", import.meta.url), "utf8");
			const matches = sidebarSrc.match(/data-export-offline="true"/g);
			expect(matches).toBeTruthy();
			expect(matches!.length).toBeGreaterThanOrEqual(3); // workspace new chat, primary-nav new chat, add workspace
		});

		it("verifies panel-context.js disables Export HTML button in exportReadOnly mode", () => {
			const panelSrc = readFileSync(new URL("../web/js/panel-context.js", import.meta.url), "utf8");
			expect(panelSrc).toContain(`disabled=\${exportReadOnly()}`);
		});
	});

	describe("W122: boot export fields carry raw source data", () => {
		const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
		const EVIL_PATH = 'C:\\a\\b</script><img src=x onerror=1>\\"x.jsonl';

		function makeSession(tag: string): SessionManager {
			const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), `w122-${tag}-`));
			const sm = SessionManager.create(join(root, "project"), join(root, "sessions"));
			sm.appendSessionInfo(`W122 ${tag}`);
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: "W122 boot fields probe" }],
				timestamp: Date.now(),
			});
			return sm;
		}

		function extractBootJs(html: string): string {
			const match = html.match(/<script id="myharness-export-boot">([\s\S]*?)<\/script>/);
			expect(match).not.toBeNull();
			return match![1];
		}

		function runBootJs(bootJs: string): any {
			const sandbox: Record<string, any> = {
				document: {
					getElementById: () => null,
					documentElement: { lang: "en", dataset: {} },
					querySelectorAll: () => [],
				},
				matchMedia: () => ({ matches: false }),
				MutationObserver: class {
					observe(): void {}
				},
				setTimeout: () => 0,
			};
			sandbox.window = sandbox;
			vm.createContext(sandbox);
			vm.runInContext(bootJs, sandbox, { filename: "export-boot.js" });
			return sandbox.__MYHARNESS_EXPORT__;
		}

		it("exposes export.sourceName/sourcePath/exportedAt without legacy bannerText/sourceLabel", async () => {
			const sm = makeSession("normal");
			const html = await buildReplayHtml({ sessionManager: sm, name: "W122 normal" });
			const runtime = runBootJs(extractBootJs(html));

			const file = sm.getSessionFile();
			if (!file) throw new Error("W122 fixture: session file missing");
			const expectedName = file.split(/[\\/]/).pop();

			expect(Object.keys(runtime.export).sort()).toEqual(["exportedAt", "sourceName", "sourcePath"]);
			expect(runtime.export.sourceName).toBe(expectedName);
			expect(runtime.export.sourcePath).toBe(file);
			expect(runtime.export.exportedAt).toBe(runtime.exportedAt);
			expect(runtime.export.exportedAt).toMatch(ISO_RE);

			expect(runtime.bannerText).toBeUndefined();
			expect(runtime.sourceLabel).toBeUndefined();
		});

		it("keeps a hostile source path intact without breaking the boot script", async () => {
			const sm = makeSession("evil");
			const html = await buildReplayHtml({ sessionFile: EVIL_PATH, sessionManager: sm });
			const bootJs = extractBootJs(html);

			expect(bootJs).toContain("\\u003C/script");
			const scriptBlocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
			expect(scriptBlocks.length).toBeGreaterThan(0);
			for (const [, inner] of scriptBlocks) {
				expect(inner).not.toMatch(/<\/script/i);
			}

			const runtime = runBootJs(bootJs);
			// basenameShort splits only on slashes, so the quote char of the trailing
			// `\"` stays in the name: the last segment of EVIL_PATH is `"x.jsonl`.
			expect(runtime.export.sourceName).toBe('"x.jsonl');
			expect(runtime.export.sourcePath).toBe(EVIL_PATH);
			expect(runtime.export.exportedAt).toBe(runtime.exportedAt);
			expect(runtime.export.exportedAt).toMatch(ISO_RE);

			expect(runtime.bannerText).toBeUndefined();
			expect(runtime.sourceLabel).toBeUndefined();
		});
	});
});
