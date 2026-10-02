import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function setup(source = "# Heading\n\nuntouched **bold**\n") {
	const root = mkdtempSync(join(tmpdir(), "myharness-md-"));
	roots.push(root);
	writeFileSync(join(root, "doc.md"), source);
	writeFileSync(join(root, "code.ts"), "const x = 1;\n");
	const server = new WebHttpServer();
	servers.push(server);
	registerFileRoutes(server, { session: { sessionManager: { getCwd: () => root } } } as unknown as WebHost);
	const { port } = await server.listen(0);
	const save = async (body: unknown) => {
		const response = await fetch(`http://127.0.0.1:${port}/api/files/markdown`, {
			method: "POST",
			headers: { "x-myharness-web": "1", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: response.status, data: (await response.json()) as { content: string; blocks: string[] } };
	};
	return { root, save, source };
}

describe("Files panel Markdown saves", () => {
	it("converts edited rich text and preserves untouched Markdown verbatim", async () => {
		const { root, save, source } = await setup();
		const result = await save({
			path: "doc.md",
			original: source,
			blocks: [
				{
					raw: "# Heading\n\n",
					html: "<h2>Changed <strong>title</strong></h2><blockquote><p>quote</p></blockquote><ul><li>item</li></ul><p><a href='https://example.com'>link</a></p><pre><code class='language-ts'>const x = 1;</code></pre>",
				},
				{ raw: "untouched **bold**\n" },
			],
		});
		expect(result.status).toBe(200);
		expect(result.data.content).toContain("## Changed **title**");
		expect(result.data.content).toContain("> quote");
		expect(result.data.content).toContain("* item");
		expect(result.data.content).toContain("[link](https://example.com)");
		expect(result.data.content).toContain("```ts\nconst x = 1;\n```");
		expect(result.data.content).toMatch(/untouched \*\*bold\*\*\n$/u);
		expect(readFileSync(join(root, "doc.md"), "utf8")).toBe(result.data.content);
	});
	it("refuses stale saves, non-Markdown and paths outside the workspace without overwriting", async () => {
		const { root, save, source } = await setup();
		writeFileSync(join(root, "doc.md"), "# External change\n");
		expect(
			(await save({ path: "doc.md", original: source, blocks: [{ raw: source, html: "<p>lost</p>" }] })).status,
		).toBe(409);
		expect((await save({ path: "code.ts", original: "const x = 1;\n", blocks: [] })).status).toBe(400);
		expect((await save({ path: "../escape.md", original: "", blocks: [] })).status).toBe(403);
		expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("# External change\n");
		expect(readFileSync(join(root, "code.ts"), "utf8")).toBe("const x = 1;\n");
	});
	it("keeps CRLF and rejects mismatching blocks and invalid UTF-8", async () => {
		const { root, save, source } = await setup("# Original\r\n");
		const result = await save({ path: "doc.md", original: source, blocks: [{ raw: source, html: "<h1>New</h1>" }] });
		expect(result.status).toBe(200);
		expect(result.data.content).not.toMatch(/(?<!\r)\n/u);
		expect((await save({ path: "doc.md", original: result.data.content, blocks: [{ raw: "wrong" }] })).status).toBe(
			400,
		);
		writeFileSync(join(root, "doc.md"), Buffer.from([0xff, 0x61]));
		expect((await save({ path: "doc.md", original: "�a", blocks: [] })).status).toBe(400);
	});
});
