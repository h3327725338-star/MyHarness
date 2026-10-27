import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(cwd: string) {
	const server = new WebHttpServer();
	registerFileRoutes(server, {
		session: { sessionManager: { getCwd: () => cwd, getDataRoot: () => join(cwd, "no-data-root") } },
	} as unknown as WebHost);
	const address = await server.listen(0);
	const get = (route: string) =>
		fetch(`http://127.0.0.1:${address.port}${route}`, { headers: { "x-myharness-web": "1" } });
	return { server, get };
}

describe("large files in the Files panel and attachments", () => {
	it("shows only the head of a large text file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "myharness-large-read-"));
		roots.push(cwd);
		const line = "0123456789abcdef\n";
		writeFileSync(join(cwd, "big.log"), line.repeat(Math.ceil((3 * 1024 * 1024) / line.length)));
		const { server, get } = await serve(cwd);
		try {
			const response = await get("/api/files/read?path=big.log");
			expect(response.status).toBe(200);
			const body = (await response.json()) as { kind: string; truncated: boolean; content: string };
			expect(body.kind).toBe("text");
			expect(body.truncated).toBe(true);
			expect(body.content.length).toBe(1.5 * 1024 * 1024);
			expect(body.content.startsWith(line)).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("streams an attachment download with its exact bytes and length", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "myharness-large-download-"));
		roots.push(cwd);
		const folder = join(cwd, "uploads", "one");
		mkdirSync(folder, { recursive: true });
		const file = join(folder, "attachment-data.bin");
		const bytes = randomBytes(3 * 1024 * 1024 + 17);
		writeFileSync(file, bytes);
		const { server, get } = await serve(cwd);
		try {
			const response = await get(`/api/uploads/download?path=${encodeURIComponent(file)}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-length")).toBe(String(bytes.length));
			expect(response.headers.get("content-disposition")).toContain("data.bin");
			expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
		} finally {
			await server.close();
		}
	});
});
