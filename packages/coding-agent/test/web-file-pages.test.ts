import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	lineIndex,
	readBytes,
	readLines,
	readSegment,
	searchBytes,
	searchLines,
	writeBytes,
	writeSegment,
} from "../src/modes/web/file-pages.ts";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const roots: string[] = [];
const servers: WebHttpServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
	const root = mkdtempSync(join(tmpdir(), "myharness-pages-"));
	roots.push(root);
	return root;
}

const b64 = (bytes: number[] | string) => Buffer.from(bytes as never).toString("base64");

describe("paged byte access for the hex editor", () => {
	it("reads a page, overwrites bytes in place and refuses stale edits", async () => {
		const file = join(tempDir(), "blob.bin");
		writeFileSync(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
		const page = await readBytes(file, 2, 4);
		expect(page).toMatchObject({ size: 8, offset: 2, data: b64([2, 3, 4, 5]) });

		await writeBytes(file, 8, [{ offset: 3, original: b64([3, 4]), data: b64([0xab, 0xcd]) }]);
		expect([...readFileSync(file)]).toEqual([0, 1, 2, 0xab, 0xcd, 5, 6, 7]);

		// The bytes changed since the page was read: nothing is written.
		await expect(
			writeBytes(file, 8, [{ offset: 3, original: b64([3, 4]), data: b64([9, 9]) }]),
		).rejects.toMatchObject({ status: 409 });
		// Another size means another file.
		await expect(writeBytes(file, 9, [{ offset: 0, original: b64([0]), data: b64([1]) }])).rejects.toMatchObject({
			status: 409,
		});
		// Edits keep the length and stay inside the file.
		await expect(writeBytes(file, 8, [{ offset: 0, original: b64([0]), data: b64([1, 2]) }])).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			writeBytes(file, 8, [{ offset: 7, original: b64([7, 0]), data: b64([1, 2]) }]),
		).rejects.toMatchObject({ status: 400 });
		expect([...readFileSync(file)]).toEqual([0, 1, 2, 0xab, 0xcd, 5, 6, 7]);
	});

	it("finds byte patterns forwards and backwards", async () => {
		const file = join(tempDir(), "blob.bin");
		writeFileSync(file, Buffer.from("xxMZyyMZzz", "latin1"));
		const pattern = Buffer.from("MZ", "latin1");
		expect((await searchBytes(file, pattern, 0)).offset).toBe(2);
		expect((await searchBytes(file, pattern, 3)).offset).toBe(6);
		expect((await searchBytes(file, pattern, 7)).offset).toBe(-1);
		expect((await searchBytes(file, pattern, 6, true)).offset).toBe(2);
		expect((await searchBytes(file, pattern, 10, true)).offset).toBe(6);
	});
});

describe("paged lines for large text files", () => {
	const makeLog = (count: number) => {
		const body = Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
		return `${body}\n`;
	};

	it("indexes lines, reads any page and searches with continuation", async () => {
		const file = join(tempDir(), "big.log");
		writeFileSync(file, makeLog(2500));
		const index = await lineIndex(file);
		expect(index.lines).toBe(2501); // the final newline starts an empty last line
		expect(index.offsets.length).toBe(3);

		const page = await readLines(file, 1998, 4);
		expect(page.start).toBe(1998);
		expect(page.lines).toEqual(["line 1998", "line 1999", "line 2000", "line 2001"]);
		expect(page.total).toBe(2501);

		const found = await searchLines(file, "LINE 24", 0, 3);
		expect(found.matches.map((m) => m.line)).toEqual([24, 240, 241]);
		expect(found.next).toBe(242);
		const rest = await searchLines(file, "line 24", found.next ?? 0, 1000);
		expect(rest.matches.map((m) => m.line)).toContain(2499);
	});

	it("edits a segment, rebuilds the index and refuses stale segments", async () => {
		const file = join(tempDir(), "big.log");
		writeFileSync(file, makeLog(1500));
		const segment = await readSegment(file, 1200, 2);
		expect(segment.text).toBe("line 1200\nline 1201\n");
		const size = readFileSync(file).length;

		// Longer replacement: written through a temporary file.
		await writeSegment(
			file,
			size,
			segment.startByte,
			segment.endByte,
			segment.text,
			"line 1200\ninserted\nline 1201\n",
		);
		expect((await readLines(file, 1199, 4)).lines).toEqual(["line 1199", "line 1200", "inserted", "line 1201"]);
		expect((await lineIndex(file)).lines).toBe(1502);

		// The old segment no longer matches the file.
		await expect(
			writeSegment(file, size, segment.startByte, segment.endByte, segment.text, "x"),
		).rejects.toMatchObject({ status: 409 });

		// Same length: written in place.
		const next = await readSegment(file, 0, 1);
		await writeSegment(file, readFileSync(file).length, next.startByte, next.endByte, next.text, "LINE 0\n");
		expect(readFileSync(file, "utf8").startsWith("LINE 0\nline 1\n")).toBe(true);
	});

	it("keeps CRLF line endings out of the shown text and inside the segment", async () => {
		const file = join(tempDir(), "crlf.txt");
		writeFileSync(file, "one\r\ntwo\r\n");
		expect((await readLines(file, 0, 5)).lines).toEqual(["one", "two", ""]);
		expect((await readSegment(file, 1, 1)).text).toBe("two\r\n");
	});
});

describe("paged file routes", () => {
	it("serves byte pages and text pages, and saves only with the Web UI header", async () => {
		const root = tempDir();
		writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 3, 4]));
		writeFileSync(join(root, "big.log"), "a\nb\nc\n");
		const server = new WebHttpServer();
		servers.push(server);
		registerFileRoutes(server, { session: { sessionManager: { getCwd: () => root } } } as unknown as WebHost);
		const { port } = await server.listen(0);
		const base = `http://127.0.0.1:${port}`;

		const page = await (await fetch(`${base}/api/files/bytes?path=blob.bin&offset=1&length=2`)).json();
		expect(page).toMatchObject({ size: 4, offset: 1, data: b64([2, 3]) });
		const lines = (await (await fetch(`${base}/api/files/text-lines?path=big.log&start=1&count=2`)).json()) as {
			lines: string[];
		};
		expect(lines.lines).toEqual(["b", "c"]);

		const body = JSON.stringify({
			path: "blob.bin",
			size: 4,
			edits: [{ offset: 0, original: b64([1]), data: b64([9]) }],
		});
		const refused = await fetch(`${base}/api/files/bytes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(refused.status).toBe(403);
		const saved = await fetch(`${base}/api/files/bytes`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-myharness-web": "1" },
			body,
		});
		expect(saved.status).toBe(200);
		expect([...readFileSync(join(root, "blob.bin"))]).toEqual([9, 2, 3, 4]);

		const outside = await fetch(`${base}/api/files/bytes?path=..%2Foutside.bin&offset=0&length=1`);
		expect(outside.status).toBeGreaterThanOrEqual(400);
	});
});
