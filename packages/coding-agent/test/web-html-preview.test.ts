import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const roots: string[] = [];
const servers: WebHttpServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "myharness-html-"));
	roots.push(root);
	mkdirSync(join(root, "site"));
	writeFileSync(join(root, "site", "index.html"), '<img src="pic.png"><script src="app.js"></script>');
	writeFileSync(join(root, "site", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(root, "site", "app.js"), "document.title = 'ok';");
	writeFileSync(join(root, "site", ".env"), "SECRET=1");
	writeFileSync(join(root, "outside.txt"), "outside the page folder");
	const server = new WebHttpServer();
	servers.push(server);
	registerFileRoutes(server, { session: { sessionManager: { getCwd: () => root } } } as unknown as WebHost);
	const { port } = await server.listen(0);
	const base = `http://127.0.0.1:${port}`;
	const response = await fetch(`${base}/api/files/site`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-myharness-web": "1" },
		body: JSON.stringify({ path: "site/index.html" }),
	});
	const { url } = (await response.json()) as { url: string };
	const folder = url.slice(0, url.lastIndexOf("/") + 1);
	// What a sandboxed (opaque-origin) page sends for its subresources.
	const fromPage = (path: string, dest: string) =>
		fetch(`${base}${path}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": dest } });
	/** A raw request, so dot segments reach the server unnormalized. */
	const raw = (path: string, headers: Record<string, string>) =>
		new Promise<number>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
	return { base, url, folder, fromPage, raw };
}

describe("HTML preview in a file tab", () => {
	it("serves the page sandboxed and its folder's files as subresources", async () => {
		const { base, url, folder, fromPage } = await setup();
		expect(url).toMatch(/^\/api\/files\/site\/[\w-]{20,}\/index\.html$/u);
		const page = await fetch(`${base}${url}`, {
			headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" },
		});
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toMatch(/^sandbox allow-scripts/u);
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).toContain("connect-src 'none'");

		expect((await fromPage(`${folder}pic.png`, "image")).status).toBe(200);
		const script = await fromPage(`${folder}app.js`, "script");
		expect(script.headers.get("content-type")).toContain("text/javascript");
	});

	it("never lets the page read files or leave its folder", async () => {
		const { folder, fromPage, raw } = await setup();
		expect((await fromPage(`${folder}pic.png`, "empty")).status).toBe(403);
		expect((await fromPage(`${folder}.env`, "script")).status).toBe(404);
		expect((await fromPage(`${folder}..%2Foutside.txt`, "image")).status).toBe(404);
		expect((await fromPage("/api/files/site/unknown/pic.png", "image")).status).toBe(404);
		// Another API route stays closed to the page, even dressed up as a preview path.
		const disguised = `${folder}%2e%2e/%2e%2e/read?path=outside.txt`;
		expect(await raw(disguised, { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" })).toBe(403);
	});

	it("only previews HTML files", async () => {
		const { base } = await setup();
		const response = await fetch(`${base}/api/files/site`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-myharness-web": "1" },
			body: JSON.stringify({ path: "outside.txt" }),
		});
		expect(response.status).toBe(400);
	});
});
