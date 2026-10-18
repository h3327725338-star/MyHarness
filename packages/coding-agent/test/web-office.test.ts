import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError, WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerOfficeRoutes, signJwt, verifyJwt } from "../src/modes/web/office.ts";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A stand-in ONLYOFFICE Docs server: healthcheck and the edited document it hands back on save. */
async function fakeDocumentServer(saved: Buffer) {
	const server: Server = createServer((req, res) => {
		if (req.url === "/healthcheck") return void res.end("true");
		if (req.url === "/saved") return void res.end(saved);
		res.statusCode = 404;
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => new Promise((resolve) => server.close(() => resolve())));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(secret?: string) {
	const root = mkdtempSync(join(tmpdir(), "myharness-office-"));
	roots.push(root);
	writeFileSync(join(root, "report.docx"), "original");
	writeFileSync(join(root, "old.doc"), "legacy");
	const ds = await fakeDocumentServer(Buffer.from("edited by the document server"));
	const server = new WebHttpServer();
	closers.push(() => server.close());
	const saved: string[] = [];
	registerOfficeRoutes(server, {
		settings: () => ({ url: ds, secret }),
		resolve: (input) => {
			if (typeof input !== "string" || input.includes("..")) throw new HttpError(403, "Forbidden");
			return join(root, input);
		},
		onSaved: (file) => saved.push(file),
	});
	const { port } = await server.listen(0);
	const base = `http://127.0.0.1:${port}`;
	const ui = { "content-type": "application/json", "x-myharness-web": "1" };
	const session = async (path: string) => {
		const response = await fetch(`${base}/api/office/session`, {
			method: "POST",
			headers: ui,
			body: JSON.stringify({ path, theme: "dark", lang: "zh-CN" }),
		});
		return (await response.json()) as { token: string; editorUrl: string; edit: boolean };
	};
	// The document server posts without the Web UI header.
	const callback = (token: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(`${base}/api/office/callback/${token}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	return { root, ds, base, session, callback, saved };
}

describe("Office editing through a document server", () => {
	it("signs and verifies HS256 tokens", () => {
		const token = signJwt({ status: 2 }, "secret");
		expect(verifyJwt(token, "secret")).toEqual({ status: 2 });
		expect(() => verifyJwt(token, "other")).toThrow();
		expect(() => verifyJwt("not.a.token", "secret")).toThrow();
	});

	it("reports the server, opens an editor page with a signed config and serves the file", async () => {
		const { base, ds, session } = await setup("lab-secret");
		const status = (await (await fetch(`${base}/api/office/status?path=report.docx`)).json()) as {
			server: unknown;
			editable: boolean;
		};
		expect(status.server).toEqual({ url: ds, reachable: true, jwt: true });
		expect(status.editable).toBe(true);

		const opened = await session("report.docx");
		expect(opened.edit).toBe(true);
		const page = await fetch(`${base}${opened.editorUrl}`);
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toContain(`script-src 'nonce-`);
		expect(csp).toContain(`frame-src ${ds}`);
		expect(csp).toContain("frame-ancestors 'self'");
		const htmlText = await page.text();
		expect(htmlText).toContain(`${ds}/web-apps/apps/api/documents/api.js`);
		const config = JSON.parse(/var config=(.*);\n/u.exec(htmlText)![1]!);
		expect(config.documentType).toBe("word");
		expect(config.editorConfig).toMatchObject({ mode: "edit", lang: "zh-CN" });
		const { token, ...unsigned } = config;
		expect(verifyJwt(token, "lab-secret")).toEqual(unsigned);

		const file = await fetch(`${base}/api/office/file/${opened.token}`);
		expect(await file.text()).toBe("original");
		expect((await fetch(`${base}/api/office/file/unknown`)).status).toBe(404);
	});

	it("opens legacy formats read-only", async () => {
		const { session } = await setup();
		expect((await session("old.doc")).edit).toBe(false);
	});

	it("writes a save back only with a valid token from the document server", async () => {
		const { root, ds, session, callback, saved } = await setup("lab-secret");
		const { token } = await session("report.docx");
		const save = { status: 6, url: `${ds}/saved`, filetype: "docx", key: "k" };

		expect((await callback(token, save)).status).toBe(403);
		expect((await callback(token, { token: signJwt(save, "wrong") })).status).toBe(403);
		expect(readFileSync(join(root, "report.docx"), "utf8")).toBe("original");

		const accepted = await callback(token, { token: signJwt(save, "lab-secret") });
		expect(await accepted.json()).toEqual({ error: 0 });
		expect(readFileSync(join(root, "report.docx"), "utf8")).toBe("edited by the document server");
		expect(saved).toEqual([join(root, "report.docx")]);

		// The Authorization header form carries the body under `payload`.
		const header = await callback(
			token,
			{ status: 4 },
			{ authorization: `Bearer ${signJwt({ payload: { status: 4 } }, "lab-secret")}` },
		);
		expect(await header.json()).toEqual({ error: 0 });
	});

	it("keeps both versions when the file changed on disk during the edit", async () => {
		const { root, ds, base, session, callback } = await setup();
		const { token } = await session("report.docx");
		writeFileSync(join(root, "report.docx"), "the agent wrote this");
		const later = new Date(Date.now() + 5000);
		utimesSync(join(root, "report.docx"), later, later);
		expect(await (await fetch(`${base}/api/office/session-state?token=${token}`)).json()).toEqual({
			changedOnDisk: true,
		});

		const response = await callback(token, { status: 2, url: `${ds}/saved`, filetype: "docx" });
		expect(await response.json()).toEqual({ error: 0 });
		expect(readFileSync(join(root, "report.docx"), "utf8")).toBe("the agent wrote this");
		const copy = readdirSync(root).find((name) => name.startsWith("report (edited "));
		expect(copy).toBeTruthy();
		expect(readFileSync(join(root, copy!), "utf8")).toBe("edited by the document server");
	});

	it("rejects cross-site callbacks and other POSTs without the Web UI header", async () => {
		const { base, session, callback } = await setup();
		const { token } = await session("report.docx");
		expect((await callback(token, { status: 4 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
		const noHeader = await fetch(`${base}/api/office/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "report.docx" }),
		});
		expect(noHeader.status).toBe(403);
	});
});
