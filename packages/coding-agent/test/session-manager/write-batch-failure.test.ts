import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FileEntry } from "../../src/session/types.ts";

const faults = vi.hoisted(() => ({ write: false, close: false, stat: false }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
			if (faults.stat) {
				faults.stat = false;
				throw new Error("stat failed");
			}
			return fs.fstatSync(...args);
		},
		writeSync: (fd: number, data: Uint8Array, offset: number, length: number, position: number) => {
			if (faults.write) {
				faults.write = false;
				fs.writeSync(fd, data, offset, Math.min(7, length), position);
				throw new Error("partial write failed");
			}
			return fs.writeSync(fd, data, offset, length, position);
		},
		closeSync: (fd: number) => {
			fs.closeSync(fd);
			if (faults.close) {
				faults.close = false;
				throw new Error("close failed");
			}
		},
	};
});

import {
	enqueueSessionAppend,
	flushSessionWrites,
	resetSessionWriteBatchOptions,
} from "../../src/session/storage/jsonl/write-batch.ts";

const roots: string[] = [];
afterEach(() => {
	resetSessionWriteBatchOptions();
	faults.write = faults.close = faults.stat = false;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pending() {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "batch-failure-"));
	roots.push(root);
	const file = join(root, "session.jsonl");
	writeFileSync(file, '{"header":true}\n');
	const entry = {
		type: "message",
		id: "one",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "hello", timestamp: 1 },
	} as FileEntry;
	enqueueSessionAppend(file, entry);
	return { file, expected: `{"header":true}\n${JSON.stringify(entry)}\n` };
}

it("rolls back a partial append and retries without duplicate bytes", () => {
	const { file, expected } = pending();
	faults.write = true;
	expect(() => flushSessionWrites(file)).toThrow("partial write failed");
	expect(readFileSync(file, "utf8")).toBe('{"header":true}\n');
	flushSessionWrites(file);
	expect(readFileSync(file, "utf8")).toBe(expected);
});

it("does not append durable bytes twice after a close failure", () => {
	const { file, expected } = pending();
	faults.close = true;
	expect(() => flushSessionWrites(file)).toThrow("close failed");
	flushSessionWrites(file);
	expect(readFileSync(file, "utf8")).toBe(expected);
});

it("can retry a failed stat without altering the file", () => {
	const { file, expected } = pending();
	faults.stat = true;
	expect(() => flushSessionWrites(file)).toThrow("stat failed");
	flushSessionWrites(file);
	expect(readFileSync(file, "utf8")).toBe(expected);
});
