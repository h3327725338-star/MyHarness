import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearParseCache,
	resetParseCacheOptions,
	resetSessionWriteBatchOptions,
} from "../../src/session/manager/index.ts";
import { walkSessionPath } from "../../src/session/projection/index.ts";
import { loadSessionTail } from "../../src/session/storage/jsonl/tail-window.ts";

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

/** A linear chain of `count` messages with large bodies. */
function writeLinearSession(file: string, sessionId: string, count: number, bodySize: number): string[] {
	const ids: string[] = [];
	const lines = [headerLine(sessionId, tmpdir())];
	let parentId: string | null = null;
	for (let i = 0; i < count; i++) {
		const id = `e${i.toString().padStart(4, "0")}`;
		ids.push(id);
		lines.push(messageLine(id, parentId, `${sessionId}-msg-${i} ${"x".repeat(bodySize)}`, 2000 + i));
		parentId = id;
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	return ids;
}

describe("Session tail window", () => {
	it("loads small files completely, exactly like a full parse", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tail-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		const ids = writeLinearSession(file, "small", 5, 10);

		const tail = loadSessionTail(file);
		expect(tail.complete).toBe(true);
		expect(tail.headBytesSkipped).toBe(0);
		expect(tail.header?.id).toBe("small");
		expect(tail.entries.map((entry) => entry.id)).toEqual(ids);
		expect(tail.danglingParentIds).toEqual([]);
		expect(tail.lastLineComplete).toBe(true);
	});

	it("marks a byte-limited window partial and reports the cut parent chain", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tail-cut-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		const ids = writeLinearSession(file, "large", 40, 2000);

		const tail = loadSessionTail(file, { maxBytes: 8192, maxEntries: 1000 });
		expect(tail.complete).toBe(false);
		expect(tail.headBytesSkipped).toBeGreaterThan(0);
		expect(tail.header?.id).toBe("large");
		expect(tail.entries.length).toBeGreaterThan(0);
		expect(tail.entries.length).toBeLessThan(ids.length);
		// The window ends at the live leaf.
		expect(tail.entries[tail.entries.length - 1]!.id).toBe(ids[ids.length - 1]);
		// The first entry in the window still points above the cut.
		expect(tail.danglingParentIds.length).toBeGreaterThan(0);

		// Branch integrity: the window alone cannot resolve the path to the root.
		const byId = new Map(tail.entries.map((entry) => [entry.id, entry]));
		const resolved = walkSessionPath(tail.entries, tail.entries[tail.entries.length - 1]!.id, byId, {
			fallbackToLastEntry: false,
		});
		expect(resolved.length).toBe(tail.entries.length);
		expect(resolved[0]!.id).not.toBe(ids[0]);
	});

	it("caps the window at maxEntries while keeping file order", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tail-cap-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		const ids = writeLinearSession(file, "capped", 40, 2000);

		const tail = loadSessionTail(file, { maxBytes: 65536, maxEntries: 3 });
		expect(tail.complete).toBe(false);
		expect(tail.entries.map((entry) => entry.id)).toEqual(ids.slice(-3));
	});

	it("excludes a torn final line instead of returning it as content", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tail-torn-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		const ids = writeLinearSession(file, "torn", 40, 2000);
		appendFileSync(file, '{"type":"message","id":"torn');

		const tail = loadSessionTail(file, { maxBytes: 8192, maxEntries: 1000 });
		expect(tail.complete).toBe(false);
		expect(tail.lastLineComplete).toBe(false);
		expect(tail.entries[tail.entries.length - 1]!.id).toBe(ids[ids.length - 1]);
		expect(tail.entries.some((entry) => entry.id === "torn")).toBe(false);
	});

	it("keeps a branch point visible as dangling instead of a second root", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tail-branch-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		const lines = [headerLine("branched", root)];
		let parentId: string | null = null;
		for (let i = 0; i < 30; i++) {
			const id = `trunk${i}`;
			lines.push(messageLine(id, parentId, `trunk ${i} ${"y".repeat(1500)}`, 2000 + i));
			parentId = id;
		}
		// Two branches off trunk29.
		lines.push(messageLine("branchA0", "trunk29", `A0 ${"a".repeat(1500)}`, 9000));
		lines.push(messageLine("branchA1", "branchA0", `A1 ${"a".repeat(1500)}`, 9001));
		lines.push(messageLine("branchB0", "trunk29", `B0 ${"b".repeat(1500)}`, 9010));
		writeFileSync(file, `${lines.join("\n")}\n`);

		const tail = loadSessionTail(file, { maxBytes: 4096, maxEntries: 1000 });
		expect(tail.complete).toBe(false);
		expect(tail.entries.map((entry) => entry.id)).toContain("branchB0");
		// trunk29 is above the cut: the window says so instead of looking whole.
		expect(tail.danglingParentIds).toContain("trunk29");
	});

	it("returns an empty complete window for a missing file", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-tail-missing-"));
		roots.push(root);
		const tail = loadSessionTail(join(root, "nope.jsonl"));
		expect(tail.complete).toBe(true);
		expect(tail.entries).toEqual([]);
		expect(tail.header).toBeNull();
	});
});
