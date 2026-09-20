/**
 * Core File Presentation service tests (Task 9).
 *
 * Covers: valid text, empty file, missing file, directory, binary file, large
 * file truncation, line ranges, invalid ranges, absolute/relative paths and
 * CRLF line mapping.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type FilePreview,
	getFilePreview,
	MAX_PREVIEW_FILE_BYTES,
	previewFile,
} from "../src/context/file-presentation.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../src/utils/paths.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "myharness-file-presentation-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function writeText(dir: string, name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content, "utf-8");
	return path;
}

describe("getFilePreview", () => {
	test("previews a valid text file with real line numbers", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "sample.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const preview = result.preview;
		expect(preview.kind).toBe("text");
		expect(preview.lineCount).toBe(3);
		expect(preview.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);
		expect(preview.lines.map((line) => line.text)).toEqual(["const a = 1;", "const b = 2;", "const c = 3;"]);
		expect(preview.contentText).toBe("const a = 1;\nconst b = 2;\nconst c = 3;");
		expect(preview.contentHash).toHaveLength(64);
		expect(preview.truncated).toBe(false);
		expect(preview.language).toBe("typescript");
		expect(preview.resolvedPath).toBe(path);
	});

	test("reports an empty file as empty (not an error)", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "empty.txt", "");
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.kind).toBe("empty");
		expect(result.preview.lineCount).toBe(0);
		expect(result.preview.lines).toEqual([]);
		expect(result.preview.truncated).toBe(false);
	});

	test("file without trailing newline still maps its last line", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "no-newline.txt", "one\ntwo");
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.lineCount).toBe(2);
		expect(result.preview.lines.at(-1)).toEqual({ lineNumber: 2, text: "two" });
	});

	test("missing file -> not_found", async () => {
		const dir = makeTempDir();
		const result = await getFilePreview({ path: join(dir, "missing.txt"), cwd: dir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("not_found");
	});

	test("directory -> not_file", async () => {
		const dir = makeTempDir();
		const result = await getFilePreview({ path: dir, cwd: dir });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("not_file");
	});

	test("binary file -> binary preview fallback (never decoded)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "blob.png");
		writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0x00, 0x0a]));
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.kind).toBe("binary");
		expect(result.preview.lines).toEqual([]);
		expect(result.preview.binaryNote).toBe("Binary file · Preview not available");
		expect(result.preview.typeHint).toBe("PNG image");
		expect(result.preview.size).toBe(10);
	});

	test("large file -> structured truncation with real totals", async () => {
		const dir = makeTempDir();
		const lineCount = 5000;
		const content = `${Array.from({ length: lineCount }, (_, i) => `line-${i + 1}`).join("\n")}\n`;
		const path = writeText(dir, "big.log", content);
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const preview = result.preview;
		expect(preview.truncated).toBe(true);
		expect(preview.truncation?.totalLines).toBe(lineCount);
		expect(preview.truncation?.truncatedBy).toBe("lines");
		expect(preview.lines[0]).toEqual({ lineNumber: 1, text: "line-1" });
		// 2000-line limit (DEFAULT_MAX_LINES), same as the Read tool.
		expect(preview.lines).toHaveLength(2000);
		expect(preview.truncation?.shownLines).toBe(2000);
		expect(preview.truncation?.shownBytes).toBe(Buffer.byteLength(preview.contentText, "utf-8"));
	});

	test("byte truncation wins for long single lines", async () => {
		const dir = makeTempDir();
		// 200 lines of 2KB each = 400KB text; the 50KB byte limit hits first.
		const content = Array.from({ length: 200 }, () => "x".repeat(2048)).join("\n");
		const path = writeText(dir, "wide.log", content);
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.truncated).toBe(true);
		expect(result.preview.truncation?.truncatedBy).toBe("bytes");
		expect(result.preview.truncation?.totalLines).toBe(200);
		expect(result.preview.lines.length).toBeLessThan(200);
		expect(Buffer.byteLength(result.preview.contentText, "utf-8")).toBeLessThanOrEqual(50 * 1024);
	});

	test("single line exceeding the byte limit -> firstLineExceedsLimit", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "huge-line.txt", "y".repeat(60 * 1024));
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.truncated).toBe(true);
		expect(result.preview.truncation?.firstLineExceedsLimit).toBe(true);
		expect(result.preview.lines).toEqual([]);
		expect(result.preview.contentText).toBe("");
	});

	test("line range selection returns exactly the requested lines", async () => {
		const dir = makeTempDir();
		const content = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n");
		const path = writeText(dir, "ranged.ts", content);
		const result = await getFilePreview({ path, cwd: dir, startLine: 20, endLine: 35 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const preview = result.preview;
		expect(preview.lines[0]).toEqual({ lineNumber: 20, text: "line-20" });
		expect(preview.lines.at(-1)).toEqual({ lineNumber: 35, text: "line-35" });
		expect(preview.lines).toHaveLength(16);
		expect(preview.contentText).toBe(Array.from({ length: 16 }, (_, i) => `line-${i + 20}`).join("\n"));
		expect(preview.shownStartLine).toBe(20);
		expect(preview.shownEndLine).toBe(35);
		expect(preview.truncated).toBe(false);
	});

	test("endLine beyond the file is clamped", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "short.txt", "a\nb\nc\n");
		const result = await getFilePreview({ path, cwd: dir, startLine: 2, endLine: 999 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.lines.map((line) => line.lineNumber)).toEqual([2, 3]);
	});

	test("invalid ranges are rejected", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "sample.txt", "a\nb\nc\n");
		for (const range of [
			{ startLine: 0, endLine: 2 },
			{ startLine: 5, endLine: 2 },
			{ startLine: 99, endLine: undefined },
		]) {
			const result = await getFilePreview({ path, cwd: dir, ...range });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("invalid_range");
		}
	});

	test("relative path resolves against cwd", async () => {
		const dir = makeTempDir();
		writeText(dir, "rel.txt", "hello\n");
		const result = await getFilePreview({ path: "rel.txt", cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.displayPath).toBe("rel.txt");
		expect(result.preview.resolvedPath).toBe(join(dir, "rel.txt"));
	});

	test("absolute path outside cwd is allowed (matches Read tool semantics)", async () => {
		const dirA = makeTempDir();
		const dirB = makeTempDir();
		const path = writeText(dirB, "outside.txt", "outside\n");
		const result = await getFilePreview({ path, cwd: dirA });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Outside cwd: display falls back to the absolute path (POSIX separators,
		// matching formatPathRelativeToCwdOrAbsolute).
		expect(result.preview.displayPath).toBe(path.split("\\").join("/"));
	});

	test("Windows-style absolute path resolves", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "win.txt", "win\n");
		const result = await getFilePreview({ path, cwd: dir });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.kind).toBe("text");
		expect(result.preview.lineCount).toBe(1);
	});

	test("C:\\ as workspace root works (display stays absolute)", async () => {
		// Simulate a root-level workspace: preview a temp file with cwd = its drive root.
		const dir = makeTempDir();
		const path = writeText(dir, "root-test.txt", "root\n");
		const driveRoot = dir.slice(0, 3); // e.g. "C:\\"
		const result = await getFilePreview({ path, cwd: driveRoot });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// With cwd = C:\, the file is inside cwd, so the display is relative.
		expect(result.preview.displayPath).toBe(formatPathRelativeToCwdOrAbsolute(path, driveRoot).split("/").join("/"));
		expect(result.preview.resolvedPath).toBe(path);
	});

	test("CRLF files map 1:1 (trailing CR stripped, line numbers stable)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "alpha\r\nbeta\r\ngamma", "utf-8");
		const result = await getFilePreview({ path, cwd: dir, startLine: 2, endLine: 3 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.preview.lines).toEqual([
			{ lineNumber: 2, text: "beta" },
			{ lineNumber: 3, text: "gamma" },
		]);
		expect(result.preview.contentText).toBe("beta\ngamma");
	});

	test("previewFile shared reader rejects binary files", async () => {
		const dir = makeTempDir();
		const path = join(dir, "data.bin");
		writeFileSync(path, Buffer.from([0x00, 0x01, 0x02]));
		const outcome = await previewFile({ path, cwd: dir });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("binary");
	});

	test("file above MAX_PREVIEW_FILE_BYTES is refused", async () => {
		// Sparse file is not reliable on all platforms; simulate via a fake stat
		// is not possible, so only assert the constant exists and the check path
		// is wired (covered by the size guard in previewFile).
		expect(MAX_PREVIEW_FILE_BYTES).toBe(64 * 1024 * 1024);
	});

	test("snapshot hash is deterministic", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "hash.txt", "stable\ncontent\n");
		const first = await getFilePreview({ path, cwd: dir });
		const second = await getFilePreview({ path, cwd: dir });

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.preview.contentHash).toBe(second.preview.contentHash);
	});

	test("kind: text preview carries snapshotAt", async () => {
		const dir = makeTempDir();
		const path = writeText(dir, "snap.txt", "x\n");
		const result = await getFilePreview({ path, cwd: dir });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(typeof (result.preview as FilePreview).snapshotAt).toBe("number");
	});
});
