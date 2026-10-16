/**
 * parse-cache 单文件上限 + env 接线：
 * 巨文件读正确但不缓存、逐出逻辑不受影响、env 映射与 0=关闭。
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearParseCache,
	getParseCacheStats,
	loadEntriesFromFile,
	resetParseCacheOptions,
	setParseCacheOptions,
} from "../../src/session/manager/index.ts";
import {
	DEFAULT_MAX_CACHED_PARSE_BYTES,
	MAX_SINGLE_PARSE_BYTES,
	resolveParseCacheLimitsFromEnv,
} from "../../src/session/storage/jsonl/parse-cache.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	clearParseCache();
	resetParseCacheOptions();
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

describe("parse cache single-file cap", () => {
	it("reads over-cap files correctly without caching them", () => {
		const root = mkdtempSync(join(tmpdir(), "parse-cache-single-cap-"));
		roots.push(root);
		const file = join(root, "big.jsonl");
		writeFileSync(file, `${headerLine("big", root)}\n${messageLine("m1", null, "x".repeat(300), 2000)}\n`);
		const size = statSync(file).size;
		// Under the total budget but over the single-file cap.
		setParseCacheOptions({ maxBytes: size + 10_000, maxSingleBytes: size - 10 });

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(getParseCacheStats().files).toBe(0);
	});

	it("still caches files under both caps", () => {
		const root = mkdtempSync(join(tmpdir(), "parse-cache-under-cap-"));
		roots.push(root);
		const file = join(root, "small.jsonl");
		writeFileSync(file, `${headerLine("small", root)}\n${messageLine("m1", null, "hi", 2000)}\n`);
		const size = statSync(file).size;
		setParseCacheOptions({ maxBytes: size + 10_000, maxSingleBytes: size + 10 });

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(getParseCacheStats().files).toBe(1);
	});

	it("treats a zero single-file cap as caching disabled", () => {
		const root = mkdtempSync(join(tmpdir(), "parse-cache-zero-cap-"));
		roots.push(root);
		const file = join(root, "s.jsonl");
		writeFileSync(file, `${headerLine("s", root)}\n${messageLine("m1", null, "hi", 2000)}\n`);
		setParseCacheOptions({ maxBytes: 10 * 1024 * 1024, maxSingleBytes: 0 });

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(getParseCacheStats().files).toBe(0);
	});

	it("still evicts by total bytes when the single cap is not the binding limit", () => {
		const root = mkdtempSync(join(tmpdir(), "parse-cache-cap-evict-"));
		roots.push(root);
		setParseCacheOptions({ maxBytes: 700, maxSingleBytes: 10 * 1024 * 1024 });
		const files = ["a.jsonl", "b.jsonl", "c.jsonl"].map((name) => {
			const file = join(root, name);
			writeFileSync(file, `${headerLine(name, root)}\n${messageLine("m1", null, "x".repeat(150), 2000)}\n`);
			return file;
		});

		for (const file of files) expect(loadEntriesFromFile(file)).toHaveLength(2);
		const stats = getParseCacheStats();
		expect(stats.bytes).toBeLessThanOrEqual(700);
		expect(stats.files).toBeLessThan(files.length);
	});
});

describe("parse cache env wiring", () => {
	it("defaults to 128MB total and 32MB per file", () => {
		expect(DEFAULT_MAX_CACHED_PARSE_BYTES).toBe(128 * 1024 * 1024);
		expect(MAX_SINGLE_PARSE_BYTES).toBe(32 * 1024 * 1024);
		expect(resolveParseCacheLimitsFromEnv({})).toEqual({
			maxBytes: 128 * 1024 * 1024,
			maxSingleBytes: 32 * 1024 * 1024,
		});
	});

	it("maps MYHARNESS_PARSE_CACHE_MB / MYHARNESS_PARSE_CACHE_FILE_MB from megabytes", () => {
		expect(
			resolveParseCacheLimitsFromEnv({
				MYHARNESS_PARSE_CACHE_MB: "64",
				MYHARNESS_PARSE_CACHE_FILE_MB: "16",
			}),
		).toEqual({ maxBytes: 64 * 1024 * 1024, maxSingleBytes: 16 * 1024 * 1024 });
	});

	it("treats 0 as caching disabled and ignores invalid values", () => {
		expect(
			resolveParseCacheLimitsFromEnv({ MYHARNESS_PARSE_CACHE_MB: "0", MYHARNESS_PARSE_CACHE_FILE_MB: "0" }),
		).toEqual({ maxBytes: 0, maxSingleBytes: 0 });
		expect(
			resolveParseCacheLimitsFromEnv({ MYHARNESS_PARSE_CACHE_MB: "abc", MYHARNESS_PARSE_CACHE_FILE_MB: "-5" }),
		).toEqual({ maxBytes: 128 * 1024 * 1024, maxSingleBytes: 32 * 1024 * 1024 });
	});

	it("reset restores the startup (env-derived) budgets", () => {
		setParseCacheOptions({ maxBytes: 123, maxSingleBytes: 45 });
		resetParseCacheOptions();
		const expected = resolveParseCacheLimitsFromEnv(process.env);
		const stats = getParseCacheStats();
		expect(stats.maxBytes).toBe(expected.maxBytes);
		expect(stats.maxSingleBytes).toBe(expected.maxSingleBytes);
	});
});
