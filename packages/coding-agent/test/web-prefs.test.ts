import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestContext, RouteHandler, WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerWebPrefsRoutes, WEB_PREFS_FILE } from "../src/modes/web/web-prefs.ts";

const boot = readFileSync(new URL("../web/js/boot-theme.js", import.meta.url), "utf8");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function routes() {
	const agentDir = mkdtempSync(join(tmpdir(), "web-prefs-"));
	dirs.push(agentDir);
	const handlers = new Map<string, RouteHandler>();
	const server = {
		route: (method: string, pattern: string, handler: RouteHandler) => handlers.set(`${method} ${pattern}`, handler),
	} as unknown as WebHttpServer;
	registerWebPrefsRoutes(server, () => agentDir);
	const call = (key: string, body?: unknown, res?: unknown) =>
		handlers.get(key)!({ body, res } as unknown as RequestContext) as Record<string, unknown>;
	return { agentDir, call };
}

/**
 * Runs boot-theme.js with a shared copy (from /api/web-prefs.js) and a localStorage copy; returns its choice. `system` is
 * the language of Windows the desktop host gave, `browser` the browser's own language.
 */
function start(
	shared: unknown,
	local: { prefs?: unknown; at?: number } = {},
	languages: { system?: unknown; browser?: string } = {},
) {
	const root = { dataset: {} as Record<string, string>, lang: "" };
	const context: Record<string, unknown> = {
		document: { documentElement: root },
		...(languages.system !== undefined ? { __MYHARNESS_SYSTEM_LANGUAGE__: languages.system } : {}),
		...(languages.browser !== undefined
			? { navigator: { languages: [languages.browser], language: languages.browser } }
			: {}),
		matchMedia: () => ({ matches: true }),
		localStorage: {
			getItem: (key: string) =>
				key === "myharness.web.prefs"
					? local.prefs === undefined
						? null
						: typeof local.prefs === "string"
							? local.prefs
							: JSON.stringify(local.prefs)
					: local.at === undefined
						? null
						: String(local.at),
		},
		__MYHARNESS_WEB_PREFS__: shared,
	};
	runInNewContext(boot, context);
	return { boot: context.__MYHARNESS_BOOT_PREFS__ as Record<string, unknown>, dataset: root.dataset, lang: root.lang };
}

describe("shared Web UI preferences", () => {
	it("stores a write, serves it to the page script and ignores an older write", () => {
		const { agentDir, call } = routes();
		expect(call("GET /api/web-prefs")).toEqual({ prefs: null, updatedAt: 0 });
		expect(call("PUT /api/web-prefs", { prefs: { theme: "dark" }, updatedAt: 20 })).toMatchObject({ ok: true });
		expect(call("PUT /api/web-prefs", { prefs: { theme: "light" }, updatedAt: 10 })).toMatchObject({
			ok: false,
			stale: true,
			prefs: { theme: "dark" },
		});
		expect(JSON.parse(readFileSync(join(agentDir, WEB_PREFS_FILE), "utf8"))).toEqual({
			prefs: { theme: "dark" },
			updatedAt: 20,
		});
		let script = "";
		const res = {
			writeHead: () => {},
			end: (text: string) => {
				script = text;
			},
		};
		call("GET /api/web-prefs.js", undefined, res);
		const context: Record<string, unknown> = {};
		runInNewContext(script, context);
		expect(context.__MYHARNESS_WEB_PREFS__).toEqual({ prefs: { theme: "dark" }, updatedAt: 20 });
		expect(context.__MYHARNESS_SYSTEM_LANGUAGE__).toBeNull();
	});

	it("gives the page the language of Windows that the desktop host passed", () => {
		const { call } = routes();
		const previous = process.env.MYHARNESS_SYSTEM_LANGUAGE;
		try {
			for (const [given, served] of [
				["zh-CN", "zh-CN"],
				["en", "en"],
				["fr", null],
			] as const) {
				process.env.MYHARNESS_SYSTEM_LANGUAGE = given;
				let script = "";
				call("GET /api/web-prefs.js", undefined, {
					writeHead: () => {},
					end: (text: string) => {
						script = text;
					},
				});
				const context: Record<string, unknown> = {};
				runInNewContext(script, context);
				expect(context.__MYHARNESS_SYSTEM_LANGUAGE__).toBe(served);
			}
		} finally {
			if (previous === undefined) delete process.env.MYHARNESS_SYSTEM_LANGUAGE;
			else process.env.MYHARNESS_SYSTEM_LANGUAGE = previous;
		}
	});

	it("starts in the language of Windows until the user picks one, and in the picked one after that", () => {
		// No preferences at all: a Simplified Chinese Windows starts in Chinese, an English one in English.
		expect(start(null, {}, { system: "zh-CN" })).toMatchObject({ lang: "zh-CN", boot: { defaultLang: "zh-CN" } });
		expect(start(null, {}, { system: "en", browser: "zh-CN" })).toMatchObject({
			lang: "en",
			boot: { defaultLang: "en" },
		});
		// Other settings saved but no language: still Windows.
		expect(start({ prefs: { theme: "dark" }, updatedAt: 1 }, {}, { system: "zh-CN" }).lang).toBe("zh-CN");
		// The user's own choice wins either way.
		expect(start({ prefs: { lang: "en" }, updatedAt: 1 }, {}, { system: "zh-CN" }).lang).toBe("en");
		expect(start({ prefs: { lang: "zh-CN" }, updatedAt: 1 }, {}, { system: "en" }).lang).toBe("zh-CN");
		// Without the desktop host (a plain browser) the browser's language decides; only Simplified Chinese is Chinese.
		expect(start(null, {}, { browser: "zh-CN" }).lang).toBe("zh-CN");
		expect(start(null, {}, { browser: "zh-Hans-SG" }).lang).toBe("zh-CN");
		expect(start(null, {}, { browser: "zh-TW" }).lang).toBe("en");
		expect(start(null, {}, { browser: "ja-JP" }).lang).toBe("en");
		expect(start(null).lang).toBe("en");
	});

	it("rejects malformed writes and treats a damaged file as no preferences", () => {
		const { agentDir, call } = routes();
		expect(() => call("PUT /api/web-prefs", { prefs: [], updatedAt: 1 })).toThrow();
		expect(() => call("PUT /api/web-prefs", { prefs: {}, updatedAt: "1" })).toThrow();
		writeFileSync(join(agentDir, WEB_PREFS_FILE), "{ damaged");
		expect(call("GET /api/web-prefs")).toEqual({ prefs: null, updatedAt: 0 });
		expect(call("PUT /api/web-prefs", { prefs: { lang: "en" }, updatedAt: 1 })).toMatchObject({ ok: true });
	});

	it("starts from the copy with the later change", () => {
		const shared = { prefs: { theme: "light", lang: "zh-CN" }, updatedAt: 100 };
		expect(start(shared, { prefs: { theme: "dark" }, at: 50 }).boot).toMatchObject({
			prefs: shared.prefs,
			push: false,
		});
		expect(start(shared, { prefs: { theme: "dark" }, at: 150 }).boot).toMatchObject({
			prefs: { theme: "dark" },
			updatedAt: 150,
			push: true,
		});
		expect(start(shared, { prefs: { theme: "dark" }, at: 50 }).dataset.theme).toBe("light");
	});

	it("moves an older version's local copy to the shared copy only when there is none yet", () => {
		expect(start(null, { prefs: { theme: "dark", motion: "on" } }).boot).toMatchObject({
			prefs: { theme: "dark", motion: "on" },
			push: true,
		});
		const shared = { prefs: { theme: "light" }, updatedAt: 5 };
		expect(start(shared, { prefs: { theme: "dark" } }).boot).toMatchObject({
			prefs: { theme: "light" },
			push: false,
		});
	});

	it("reports a local copy it cannot read unless the shared copy replaces it", () => {
		expect(start(null, { prefs: "{ damaged" }).boot).toMatchObject({ prefs: {}, unreadable: true, push: false });
		expect(start(null, { prefs: "[1]" }).boot).toMatchObject({ unreadable: true });
		expect(start({ prefs: { theme: "dark" }, updatedAt: 1 }, { prefs: "{ damaged" }).boot).toMatchObject({
			prefs: { theme: "dark" },
			unreadable: false,
		});
		expect(start(undefined).boot).toMatchObject({ prefs: {}, unreadable: false, push: false });
	});
});
