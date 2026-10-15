import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearParseCache,
	getParseCacheStats,
	loadEntriesFromFile,
	resetParseCacheOptions,
	resetSessionWriteBatchOptions,
	setParseCacheOptions,
} from "../../src/session/manager/index.ts";
import type { SessionJsonlDiagnostics } from "../../src/session/types.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	clearParseCache();
	resetParseCacheOptions();
	resetSessionWriteBatchOptions();
});

function headerLine(id: string, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(1000).toISOString(), cwd });
}

function messageLine(id: string, parentId: string | null, text: string, at: number): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	});
}

function freshDiagnostics(): SessionJsonlDiagnostics {
	return { recovered: false, issues: [] };
}

describe("Session parse cache", () => {
	it("serves repeated loads from cache and parses only appended bytes on growth", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-parse-cache-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, `${headerLine("s1", root)}\n${messageLine("m1", null, "alpha", 2000)}\n`);

		const first = loadEntriesFromFile(file);
		expect(first.map((entry) => (entry.type === "session" ? "session" : entry.id))).toEqual(["session", "m1"]);
		expect(getParseCacheStats().files).toBe(1);

		const second = loadEntriesFromFile(file);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		expect(getParseCacheStats().files).toBe(1);

		appendFileSync(file, `${messageLine("m2", "m1", "beta", 3000)}\n`);
		const third = loadEntriesFromFile(file);
		expect(third.map((entry) => (entry.type === "session" ? "session" : entry.id))).toEqual(["session", "m1", "m2"]);
		// Still a single cached snapshot: the prefix was reused, not re-parsed.
		expect(getParseCacheStats().files).toBe(1);
	});

	it("does not reuse an in-place same-size replacement", () => {
		const root = mkdtempSync(join(tmpdir(), "parse-cache-replace-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, `${headerLine("s", root)}\n${messageLine("m", null, "old", 1)}\n`);
		loadEntriesFromFile(file);
		writeFileSync(file, `${headerLine("s", root)}\n${messageLine("m", null, "new", 1)}\n`);
		utimesSync(file, new Date(), new Date(Date.now() + 2000));
		expect(JSON.stringify(loadEntriesFromFile(file))).toContain("new");
	});

	it("rechecks an unterminated valid last line when a newline and entry arrive", () => {
		const root = mkdtempSync(join(tmpdir(), "parse-cache-tail-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, `${headerLine("s", root)}\n${messageLine("m1", null, "first", 1)}`);
		expect(loadEntriesFromFile(file)).toHaveLength(2);
		appendFileSync(file, `\n${messageLine("m2", "m1", "second", 2)}\n`);
		const loaded = loadEntriesFromFile(file);
		expect(loaded).toHaveLength(3);
		expect(loaded.filter((entry) => entry.type !== "session").map((entry) => entry.id)).toEqual(["m1", "m2"]);
	});

	it("keeps recovery diagnostics stable across cache hits", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-parse-cache-diag-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, `${headerLine("s1", root)}\nnot-json\n${messageLine("m1", null, "alpha", 2000)}\n`);

		const first = freshDiagnostics();
		expect(loadEntriesFromFile(file, first)).toHaveLength(2);
		expect(first.issues).toEqual([expect.objectContaining({ line: 2, kind: "malformed_line" })]);

		const second = freshDiagnostics();
		expect(loadEntriesFromFile(file, second)).toHaveLength(2);
		expect(second).toEqual(first);
	});

	it("stops reporting a torn tail once its bytes complete", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-parse-cache-tail-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		const full = messageLine("m1", null, "alpha", 2000);
		const cut = Math.floor(full.length / 2);
		writeFileSync(file, `${headerLine("s1", root)}\n${full.slice(0, cut)}`);

		const torn = freshDiagnostics();
		expect(loadEntriesFromFile(file, torn)).toHaveLength(1);
		expect(torn.issues).toEqual([expect.objectContaining({ kind: "truncated_tail" })]);

		appendFileSync(file, `${full.slice(cut)}\n`);
		const completed = freshDiagnostics();
		const entries = loadEntriesFromFile(file, completed);
		expect(entries).toHaveLength(2);
		expect(completed.issues).toEqual([]);
		expect(completed.recovered).toBe(false);
	});

	it("evicts by bytes, not by file count", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-parse-cache-budget-"));
		roots.push(root);
		setParseCacheOptions({ maxBytes: 700 });
		const files = ["a.jsonl", "b.jsonl", "c.jsonl"].map((name) => {
			const file = join(root, name);
			writeFileSync(file, `${headerLine(name, root)}\n${messageLine("m1", null, "x".repeat(150), 2000)}\n`);
			return file;
		});

		for (const file of files) expect(loadEntriesFromFile(file)).toHaveLength(2);
		const stats = getParseCacheStats();
		expect(stats.bytes).toBeLessThanOrEqual(700);
		expect(stats.files).toBeLessThan(files.length);
		// Evicted files still load correctly.
		for (const file of files) expect(loadEntriesFromFile(file)).toHaveLength(2);
	});

	it("does not cache files larger than the whole budget", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-parse-cache-huge-"));
		roots.push(root);
		setParseCacheOptions({ maxBytes: 200 });
		const file = join(root, "big.jsonl");
		writeFileSync(file, `${headerLine("big", root)}\n${messageLine("m1", null, "x".repeat(300), 2000)}\n`);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(getParseCacheStats().files).toBe(0);
	});

	it("re-reads atomically replaced files instead of serving the stale snapshot", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-parse-cache-replace-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, `${headerLine("v1", root)}\n${messageLine("m1", null, "alpha", 2000)}\n`);
		expect(loadEntriesFromFile(file)[0]).toMatchObject({ id: "v1" });

		rmSync(file);
		writeFileSync(file, `${headerLine("v2", root)}\n${messageLine("n1", null, "beta", 3000)}\n`);
		const reloaded = loadEntriesFromFile(file);
		expect(reloaded[0]).toMatchObject({ id: "v2" });
		expect(reloaded.map((entry) => (entry.type === "session" ? "session" : entry.id))).toEqual(["session", "n1"]);
	});
});
