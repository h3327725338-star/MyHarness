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

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "myharness-preview-"));
	roots.push(root);
	writeFileSync(join(root, "paper.pdf"), Buffer.from("%PDF-1.4\n%fake body for range tests\n"));
	writeFileSync(join(root, "song.mp3"), Buffer.from("ID3\u0004\u0000\u0000\u0000", "latin1"));
	writeFileSync(join(root, "clip.mp4"), Buffer.from("\u0000\u0000\u0000\u0018ftypisom", "latin1"));
	writeFileSync(join(root, "report.docx"), Buffer.from("PK\u0003\u0004fake docx", "latin1"));
	writeFileSync(join(root, "notes.txt"), "line one\r\nline two\r\n");
	writeFileSync(join(root, "binary.dat"), Buffer.from([0x00, 0x01, 0x02]));
	const server = new WebHttpServer();
	servers.push(server);
	registerFileRoutes(server, { session: { sessionManager: { getCwd: () => root } } } as unknown as WebHost);
	const { port } = await server.listen(0);
	const url = (path: string, query = "") => `http://127.0.0.1:${port}${path}${query ? `?${query}` : ""}`;
	const read = async (path: string) => {
		const response = await fetch(url("/api/files/read", `path=${encodeURIComponent(path)}`));
		return { status: response.status, data: (await response.json()) as Record<string, unknown> };
	};
	const raw = (path: string, range?: string) =>
		fetch(url("/api/files/raw", `path=${encodeURIComponent(path)}`), range ? { headers: { range } } : undefined);
	const save = async (body: unknown) => {
		const response = await fetch(url("/api/files/text"), {
			method: "POST",
			headers: { "x-myharness-web": "1", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: response.status, data: (await response.json()) as Record<string, unknown> };
	};
	return { root, read, raw, save };
}

describe("Files panel media and document previews", () => {
	it("classifies PDF, audio, video and Office files with a raw URL instead of reading them as text", async () => {
		const { read } = await setup();
		const pdf = await read("paper.pdf");
		expect(pdf.status).toBe(200);
		expect(pdf.data.kind).toBe("pdf");
		expect(pdf.data.mimeType).toBe("application/pdf");
		expect(pdf.data.rawUrl).toBe("/api/files/raw?path=paper.pdf");

		expect((await read("song.mp3")).data).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
		expect((await read("clip.mp4")).data).toMatchObject({ kind: "video", mimeType: "video/mp4" });
		expect((await read("report.docx")).data).toMatchObject({ kind: "office" });
	});

	it("streams raw bytes with range support and refuses paths outside the workspace", async () => {
		const { raw, root } = await setup();
		const whole = await raw("paper.pdf");
		expect(whole.status).toBe(200);
		expect(whole.headers.get("content-type")).toBe("application/pdf");
		expect(whole.headers.get("content-disposition")).toContain("inline");
		expect(await whole.text()).toBe("%PDF-1.4\n%fake body for range tests\n");

		const partial = await raw("paper.pdf", "bytes=0-3");
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-range")).toBe("bytes 0-3/36");
		expect(await partial.text()).toBe("%PDF");

		const outside = await raw("../escape.pdf");
		expect(outside.status).toBe(403);
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toContain("line one");
	});

	it("saves UTF-8 text with a byte baseline and keeps a BOM", async () => {
		const { root, read, save } = await setup();
		const text = await read("notes.txt");
		const original = String(text.data.content);
		const saved = await save({ path: "notes.txt", original, content: "changed\r\n" });
		expect(saved.status).toBe(200);
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("changed\r\n");

		writeFileSync(join(root, "bom.txt"), "\uFEFFhello\n");
		const bom = await read("bom.txt");
		expect(String(bom.data.content)).toBe("\uFEFFhello\n");
	});
});

describe("Files panel text saves are safe", () => {
	it("refuses a stale baseline, binary files and paths outside the workspace", async () => {
		const { root, save } = await setup();
		expect((await save({ path: "notes.txt", original: "something else\n", content: "lost\n" })).status).toBe(409);
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("line one\r\nline two\r\n");

		expect((await save({ path: "binary.dat", original: "\u0000\u0001\u0002", content: "text" })).status).toBe(400);
		expect(
			(await save({ path: "paper.pdf", original: "%PDF-1.4\n%fake body for range tests\n", content: "x" })).status,
		).toBe(400);
		expect((await save({ path: "../escape.txt", original: "", content: "x" })).status).toBe(403);
		expect(readFileSync(join(root, "binary.dat")).length).toBe(3);
	});

	it("rejects non-UTF-8 files instead of rewriting them", async () => {
		const { root, save } = await setup();
		writeFileSync(join(root, "latin1.txt"), Buffer.from([0xe9, 0x0a]));
		const result = await save({ path: "latin1.txt", original: "�\n", content: "x" });
		expect(result.status).toBe(400);
		expect(readFileSync(join(root, "latin1.txt"))).toEqual(Buffer.from([0xe9, 0x0a]));
	});
});
