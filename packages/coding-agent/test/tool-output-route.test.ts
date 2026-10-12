// Locks for GET /api/tool-output after the chunked first-block change (W188): byte-offset reads with
// offset/limit/truncated/nextOffset, the 512 KB default and clamp, UTF-8 blocks cut back to a
// character boundary, out-of-range offsets answering empty instead of throwing, and the 4 MB
// cumulative window. Old fields (size/truncated/text) must stay for callers that pass no parameters.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const DEFAULT_CHUNK = 512 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;

type ToolOutput = { size: number; truncated: boolean; nextOffset: number; text: string };

async function serveFixture(
	fileName: string,
	content: Buffer,
): Promise<{ port: number; path: string; close: () => Promise<void> }> {
	const root = mkdtempSync(join(tmpdir(), "myharness-tool-output-"));
	const dir = join(root, "tool-results");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, fileName);
	writeFileSync(path, content);
	const server = new WebHttpServer();
	const host = { session: { sessionManager: { getSessionDir: () => root } } };
	registerFileRoutes(server, host as unknown as WebHost);
	const { port } = await server.listen(0);
	return {
		port,
		path,
		close: async () => {
			await server.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function fetchChunk(port: number, path: string, params: Record<string, number | undefined>): Promise<ToolOutput> {
	const query = new URLSearchParams({ path });
	for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
	const response = await fetch(`http://127.0.0.1:${port}/api/tool-output?${query.toString()}`, {
		headers: { "x-myharness-web": "1" },
	});
	expect(response.status).toBe(200);
	return (await response.json()) as ToolOutput;
}

it("answers a no-parameter request with the first 512 KB block and keeps the legacy fields", async () => {
	const fixture = await serveFixture("ascii-1mb.txt", Buffer.from("a".repeat(1024 * 1024), "utf8"));
	try {
		const first = await fetchChunk(fixture.port, fixture.path, {});
		// Old consumers read { size, truncated, text }; they stay present and consistent.
		expect(first.size).toBe(1024 * 1024);
		expect(first.text.length).toBe(DEFAULT_CHUNK);
		expect(first.truncated).toBe(true);
		expect(first.nextOffset).toBe(DEFAULT_CHUNK);
		const second = await fetchChunk(fixture.port, fixture.path, { offset: first.nextOffset });
		expect(second.text.length).toBe(1024 * 1024 - DEFAULT_CHUNK);
		expect(second.truncated).toBe(false);
		expect(second.nextOffset).toBe(second.size);
	} finally {
		await fixture.close();
	}
});

it("clamps limit to the 512 KB block size", async () => {
	const fixture = await serveFixture("clamp.txt", Buffer.from("b".repeat(1024 * 1024), "utf8"));
	try {
		const over = await fetchChunk(fixture.port, fixture.path, { limit: 16 * 1024 * 1024 });
		expect(Buffer.byteLength(over.text, "utf8")).toBe(DEFAULT_CHUNK);
		expect(over.nextOffset).toBe(DEFAULT_CHUNK);
		expect(over.truncated).toBe(true);
	} finally {
		await fixture.close();
	}
});

it("cuts blocks back to a UTF-8 character boundary and reassembles the file byte-exactly", async () => {
	const emoji = "🚀";
	const cjk = "汉字";
	const source = Buffer.concat([
		Buffer.from("x".repeat(99), "utf8"),
		Buffer.from(emoji, "utf8"), // starts at byte 99, so any block ending inside it must cut back
		Buffer.from(cjk.repeat(400), "utf8"),
		Buffer.from("🚀汉字 tail\n", "utf8"),
	]);
	const fixture = await serveFixture("utf8.txt", source);
	try {
		// A 100-byte window lands in the middle of the 4-byte rocket: it returns only the 99 x's.
		const cut = await fetchChunk(fixture.port, fixture.path, { offset: 0, limit: 100 });
		expect(cut.nextOffset).toBe(99);
		expect(cut.text).toBe("x".repeat(99));
		expect(cut.truncated).toBe(true);
		expect(cut.text).not.toContain("\uFFFD");
		// Walk the whole file in small blocks: every nextOffset must be a character boundary and the
		// concatenation must equal the source byte-for-byte with no replacement characters anywhere.
		let offset = 0;
		let text = "";
		let steps = 0;
		while (offset < source.length && steps < 200) {
			const block = await fetchChunk(fixture.port, fixture.path, { offset, limit: 100 });
			expect(block.nextOffset).toBeGreaterThan(offset);
			expect(Buffer.from(block.text, "utf8")).toHaveLength(block.nextOffset - offset);
			expect(block.text).not.toContain("\uFFFD");
			text += block.text;
			offset = block.nextOffset;
			steps += 1;
		}
		expect(offset).toBe(source.length);
		expect(Buffer.from(text, "utf8")).toEqual(source);
	} finally {
		await fixture.close();
	}
});

it("answers an out-of-range offset with an empty block instead of throwing", async () => {
	const fixture = await serveFixture("eof.txt", Buffer.from("short text", "utf8"));
	try {
		const beyond = await fetchChunk(fixture.port, fixture.path, { offset: 10 });
		expect(beyond.size).toBe(10);
		expect(beyond.text).toBe("");
		expect(beyond.truncated).toBe(false);
		expect(beyond.nextOffset).toBe(10);
		const wayBeyond = await fetchChunk(fixture.port, fixture.path, { offset: 999_999 });
		expect(wayBeyond.text).toBe("");
		expect(wayBeyond.truncated).toBe(false);
		expect(wayBeyond.nextOffset).toBe(10);
	} finally {
		await fixture.close();
	}
});

it("stops the cumulative window at 4 MB and reports it as truncated, never beyond", async () => {
	const fixture = await serveFixture("big-5mb.txt", Buffer.alloc(5 * 1024 * 1024, 0x63));
	try {
		let offset = 0;
		let delivered = 0;
		let last: ToolOutput | undefined;
		for (let i = 0; i < 64; i += 1) {
			last = await fetchChunk(fixture.port, fixture.path, { offset });
			delivered += Buffer.byteLength(last.text, "utf8");
			// Loop-stop rule shared with the frontend: an empty block ends the chain.
			if (last.text.length === 0 || last.nextOffset <= offset) break;
			offset = last.nextOffset;
		}
		expect(last).toBeDefined();
		expect(last!.truncated).toBe(true);
		expect(last!.text).toBe("");
		expect(last!.nextOffset).toBe(MAX_TOTAL);
		expect(delivered).toBe(MAX_TOTAL);
		// Asking inside the file but past the window still answers cleanly, no throw.
		const past = await fetchChunk(fixture.port, fixture.path, { offset: MAX_TOTAL + 10 });
		expect(past.text).toBe("");
		expect(past.truncated).toBe(true);
		expect(past.nextOffset).toBe(MAX_TOTAL);
	} finally {
		await fixture.close();
	}
});

it("keeps the existing access rules: unknown path 404, foreign path 403, missing parameter 400", async () => {
	const fixture = await serveFixture("rules.txt", Buffer.from("hello", "utf8"));
	try {
		const outside = join(fixture.path, "..", "..", "outside.txt");
		writeFileSync(outside, "nope");
		const query = (path: string) =>
			fetch(`http://127.0.0.1:${fixture.port}/api/tool-output?path=${encodeURIComponent(path)}`, {
				headers: { "x-myharness-web": "1" },
			});
		expect((await query(`${fixture.path}-missing.txt`)).status).toBe(404);
		expect((await query(outside)).status).toBe(403);
		expect(
			(
				await fetch(`http://127.0.0.1:${fixture.port}/api/tool-output`, {
					headers: { "x-myharness-web": "1" },
				})
			).status,
		).toBe(400);
	} finally {
		await fixture.close();
	}
});
