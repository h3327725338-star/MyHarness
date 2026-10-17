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

/** Runs boot-theme.js with a shared copy (from /api/web-prefs.js) and a localStorage copy; returns its choice. */
function start(shared: unknown, local: { prefs?: unknown; at?: number } = {}) {
	const root = { dataset: {} as Record<string, string>, lang: "" };
	const context: Record<string, unknown> = {
		document: { documentElement: root },
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
	return { boot: context.__MYHARNESS_BOOT_PREFS__ as Record<string, unknown>, dataset: root.dataset };
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
