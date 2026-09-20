import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/tools/output-accumulator.ts";

const ORIGINAL_TEMP = {
	TMPDIR: process.env.TMPDIR,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
};

function useUnusableTempDir(): void {
	// A path whose parent does not exist makes the temp-file open fail with ENOENT.
	const invalid = join(
		tmpdir(),
		`myharness-missing-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		"nested",
	);
	process.env.TMPDIR = invalid;
	process.env.TEMP = invalid;
	process.env.TMP = invalid;
}

afterEach(() => {
	if (ORIGINAL_TEMP.TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = ORIGINAL_TEMP.TMPDIR;
	if (ORIGINAL_TEMP.TEMP === undefined) delete process.env.TEMP;
	else process.env.TEMP = ORIGINAL_TEMP.TEMP;
	if (ORIGINAL_TEMP.TMP === undefined) delete process.env.TMP;
	else process.env.TMP = ORIGINAL_TEMP.TMP;
});

describe("OutputAccumulator temp file handling", () => {
	it("persists and exposes the full output path when truncation happens", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 64, tempFilePrefix: "myharness-accumulator-test" });
		accumulator.append(Buffer.from(`${"line\n".repeat(200)}`, "utf8"));
		accumulator.finish();

		const snapshot = accumulator.snapshot({ persistIfTruncated: true });
		await accumulator.closeTempFile();

		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.fullOutputPath).toBeDefined();
		expect(existsSync(snapshot.fullOutputPath!)).toBe(true);
		expect(readFileSync(snapshot.fullOutputPath!, "utf8")).toContain("line");
		rmSync(snapshot.fullOutputPath!, { force: true });
	});

	it("never crashes, hangs, or advertises a path when the temp file cannot be created", async () => {
		useUnusableTempDir();
		const accumulator = new OutputAccumulator({ maxBytes: 64, tempFilePrefix: "myharness-accumulator-test" });
		accumulator.append(Buffer.from("x".repeat(500), "utf8"));
		accumulator.finish();

		const snapshot = accumulator.snapshot({ persistIfTruncated: true });
		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();

		// The command result is still available; only the best-effort temp file is gone.
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.content.length).toBeGreaterThan(0);
		expect(snapshot.fullOutputPath).toBeUndefined();
	});

	it("keeps accepting appends after a temp-file failure", async () => {
		useUnusableTempDir();
		const accumulator = new OutputAccumulator({ maxBytes: 16, tempFilePrefix: "myharness-accumulator-test" });
		accumulator.append(Buffer.from("first".repeat(50), "utf8"));
		accumulator.append(Buffer.from("second".repeat(50), "utf8"));
		accumulator.finish();

		const snapshot = accumulator.snapshot();
		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		expect(snapshot.fullOutputPath).toBeUndefined();
	});

	it("preserves a UTF-8 boundary and the exact sidecar bytes for a large append", async () => {
		const prefix = Buffer.alloc(64 * 1024 - 1, 0x61);
		const payload = Buffer.concat([prefix, Buffer.from("😀\n尾\n".repeat(2_000), "utf8")]);
		const accumulator = new OutputAccumulator({ maxBytes: 128, tempFilePrefix: "myharness-accumulator-test" });
		accumulator.append(payload);
		accumulator.finish();

		const snapshot = accumulator.snapshot({ persistIfTruncated: true });
		await accumulator.closeTempFile();

		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.fullOutputPath).toBeDefined();
		expect(readFileSync(snapshot.fullOutputPath!)).toEqual(payload);
		rmSync(snapshot.fullOutputPath!, { force: true });
	});
});
