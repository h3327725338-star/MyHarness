import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { withSelectionBridge } from "../src/modes/web/html-preview.ts";
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

	it("adds only the selection bridge to the page, early and never before the doctype", async () => {
		const { base, url, folder, fromPage } = await setup();
		const page = await (
			await fetch(`${base}${url}`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" } })
		).text();
		// No head or doctype: the bridge comes first, the page follows unchanged.
		expect(page.startsWith("<script>")).toBe(true);
		expect(page).toContain("myharness:selection");
		expect(page.endsWith('<img src="pic.png"><script src="app.js"></script>')).toBe(true);
		// Subresources are served as they are on disk.
		expect(await (await fromPage(`${folder}app.js`, "script")).text()).toBe("document.title = 'ok';");

		const bridged = (source: string) => withSelectionBridge(Buffer.from(source, "utf8")).toString("utf8");
		const full = bridged(
			'<!DOCTYPE html> <html lang="en"><head><meta charset="utf-8"><script src="a.js"></script></head><body><header>x</header></body></html>',
		);
		expect(full.startsWith('<!DOCTYPE html> <html lang="en"><head><script>')).toBe(true);
		expect(full.indexOf("myharness:selection")).toBeLessThan(full.indexOf('<script src="a.js">'));
		// <header> is not a <head>.
		const noHead = bridged("<!doctype html><body><header>x</header></body>");
		expect(noHead.startsWith("<!doctype html><script>")).toBe(true);
		expect(bridged("<html><body>x</body></html>").startsWith("<html><script>")).toBe(true);
		// A byte-order mark stays in front; other encodings pass through byte for byte.
		const bom = withSelectionBridge(Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
		expect([...bom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const gbk = Buffer.from([0x3c, 0x68, 0x65, 0x61, 0x64, 0x3e, 0xc4, 0xe3, 0xba, 0xc3]);
		expect([...withSelectionBridge(gbk).subarray(-4)]).toEqual([0xc4, 0xe3, 0xba, 0xc3]);
	});

	it("puts the bridge after the page's first tokens only: never in a script, comment or attribute, nor before the doctype", () => {
		const script = withSelectionBridge(Buffer.alloc(0)).toString("utf8");
		/** The page up to the bridge; the rest of the page must follow it unchanged. */
		const placeOf = (source: string) => {
			const out = withSelectionBridge(Buffer.from(source, "utf8")).toString("utf8");
			const at = out.indexOf(script);
			expect(out.slice(0, at) + out.slice(at + script.length)).toBe(source);
			return source.slice(0, at);
		};
		// A "<head>" in a script, a comment, a textarea or an attribute value is not the page's head.
		const write = '<!doctype html><html><body><script>w.document.write("<head><title>x</title></head>")</script>';
		expect(placeOf(write)).toBe("<!doctype html><html>");
		expect(placeOf("<!doctype html><!-- see <head> below --><p>x")).toBe("<!doctype html><!-- see <head> below -->");
		expect(placeOf("<html><body><textarea><head></textarea>")).toBe("<html>");
		const quoted = `<html data-x="a>b" lang=en><!-- c -->\n<head data-y='<head>' id=h>`;
		expect(placeOf(`${quoted}<title>t</title>`)).toBe(quoted);
		// Comments, an xml prolog or other "<!…>" before the doctype: still after the doctype (else quirks mode).
		expect(placeOf("<!-- generated --><!doctype html><title>x</title><p>hi")).toBe(
			"<!-- generated --><!doctype html>",
		);
		expect(placeOf('<?xml version="1.0"?>\n<!DOCTYPE html>\n<p>x')).toBe('<?xml version="1.0"?>\n<!DOCTYPE html>\n');
		const comments = "<!--><!---><!-- a --!>\n<!-- b ---><!DOCTYPE html><html><head>";
		expect(placeOf(`${comments}<title>t</title>`)).toBe(comments);
		const xhtml =
			'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>';
		expect(placeOf(`${xhtml}<title>t</title>`)).toBe(xhtml);
		// A tag that never closes, or a comment that never ends, is not stepped into.
		expect(placeOf('<!doctype html><html lang="en><head>')).toBe("<!doctype html>");
		expect(placeOf("<!doctype html><!-- never ends <head>")).toBe("<!doctype html>");
		expect(placeOf("<HTML><HEAD/>x")).toBe("<HTML><HEAD/>");
	});

	it("keeps a UTF-16 page (byte-order mark first) in its own encoding", () => {
		const script = withSelectionBridge(Buffer.alloc(0)).toString("utf8");
		const page = "<!doctype html><html><head><title>t</title></head><body><p>hello UTF16 ü 中</p></body></html>";
		for (const [mark, swap] of [
			[[0xff, 0xfe], false],
			[[0xfe, 0xff], true],
		] as const) {
			const units = Buffer.from(page, "utf16le");
			if (swap) units.swap16();
			const out = withSelectionBridge(Buffer.concat([Buffer.from(mark), units]));
			expect([...out.subarray(0, 2)]).toEqual([...mark]);
			const body = Buffer.from(out.subarray(2));
			if (swap) body.swap16();
			expect(body.toString("utf16le")).toBe(page.replace("<head>", `<head>${script}`));
		}
	});

	it("reads only the start of a page, in linear time, whatever it holds", () => {
		const MiB = 1024 * 1024;
		const started = performance.now();
		// Each of these took the old whole-page regexes minutes to hours ("<head " with no ">" anywhere).
		for (const unit of ["<head ", "<html ", "<!---->", "<html a=b ", "<!--"]) {
			const page = Buffer.from(unit.repeat(Math.ceil((8 * MiB) / unit.length)), "latin1");
			const out = withSelectionBridge(page);
			// Bridged at the start, or left as it is when its start is too long to tell: either way the page is whole.
			expect(out.length === page.length || out.subarray(out.length - page.length).equals(page)).toBe(true);
		}
		withSelectionBridge(Buffer.from("<head ".repeat(400_000), "latin1"));
		expect(performance.now() - started).toBeLessThan(2000);
		// A prologue longer than what is read (before its doctype) gets no bridge rather than one before the doctype.
		const long = Buffer.from(`<!--${"x".repeat(2 * MiB)}--><!doctype html><p>x`, "latin1");
		expect(withSelectionBridge(long).equals(long)).toBe(true);
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
