/**
 * Core Context Items tests (Task 9).
 *
 * Covers: Core formatting of file/range/diff/comment items, provenance
 * validation at prompt submission time, stale detection after file changes,
 * and rejection of malformed/oversized payloads.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	CONTEXT_ATTACHMENT_CUSTOM_TYPE,
	type CommentContextItem,
	type DiffContextItem,
	type FileContextItem,
	formatContextItemsForPrompt,
	validateContextItems,
} from "../src/context/context-items.ts";
import { getFileDiff } from "../src/context/file-diff.ts";
import { getFilePreview, previewFile } from "../src/context/file-presentation.ts";
import { runGitSync } from "../src/utils/git-command.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "myharness-context-items-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function fileItem(
	dir: string,
	name: string,
	content: string,
	range?: { startLine?: number; endLine?: number },
): Promise<FileContextItem> {
	const path = join(dir, name);
	writeFileSync(path, content, "utf-8");
	const result = await getFilePreview({ path, cwd: dir, ...(range ?? {}) });
	if (!result.ok) throw new Error(`preview failed: ${result.message}`);
	return {
		kind: "file",
		path,
		startLine: range?.startLine,
		endLine: range?.endLine,
		lines: result.preview.lines,
		contentText: result.preview.contentText,
		contentHash: result.preview.contentHash,
		truncated: result.preview.truncated,
		truncation: result.preview.truncation,
		lineCount: result.preview.lineCount,
		snapshotAt: Date.now(),
	};
}

function initRepo(dir: string): void {
	runGitSync(["init", "-q"], { cwd: dir });
	runGitSync(["config", "core.autocrlf", "false"], { cwd: dir });
	runGitSync(["config", "user.name", "MyHarness Test"], { cwd: dir });
	runGitSync(["config", "user.email", "myharness-test@example.com"], { cwd: dir });
}

function commitAll(dir: string, message: string): void {
	runGitSync(["add", "-A"], { cwd: dir });
	const result = runGitSync(["commit", "-q", "-m", message], { cwd: dir });
	expect(result.ok).toBe(true);
}

describe("formatContextItemsForPrompt", () => {
	test("formats a whole-file item", () => {
		const item: FileContextItem = {
			kind: "file",
			path: "C:/work/runtime.ts",
			lines: [{ lineNumber: 1, text: "const x = 1;" }],
			contentText: "const x = 1;",
			contentHash: "abc",
			truncated: false,
			lineCount: 1,
			snapshotAt: 0,
		};
		const { text, summaries } = formatContextItemsForPrompt([item], "C:/work");
		expect(text).toBe("[File context]\nPath: runtime.ts\nLines: whole file\n\nconst x = 1;");
		expect(summaries).toEqual([
			{ kind: "file", path: "runtime.ts", label: "runtime.ts · whole file", truncated: false },
		]);
	});

	test("formats a file range item with real line numbers", () => {
		const item: FileContextItem = {
			kind: "file",
			path: "C:/work/runtime.ts",
			startLine: 210,
			endLine: 228,
			lines: [{ lineNumber: 210, text: "code" }],
			contentText: "code",
			contentHash: "abc",
			truncated: false,
			lineCount: 500,
			snapshotAt: 0,
		};
		const { text } = formatContextItemsForPrompt([item], "C:/work");
		expect(text).toBe("[File context]\nPath: runtime.ts\nLines: lines 210-228\n\ncode");
	});

	test("formats a diff item with the real unified diff", () => {
		const item: DiffContextItem = {
			kind: "diff",
			path: "C:/work/rpc-mode.ts",
			diff: {
				status: "diff",
				path: "C:/work/rpc-mode.ts",
				resolvedPath: "C:/work/rpc-mode.ts",
				displayPath: "rpc-mode.ts",
				cwd: "C:/work",
				unified: "@@ -1,2 +1,3 @@\n a\n+b\n",
				diffHash: "hash",
				hunks: [],
				truncated: false,
				snapshotAt: 0,
			},
			snapshotAt: 0,
		};
		const { text } = formatContextItemsForPrompt([item], "C:/work");
		expect(text).toBe("[Diff context]\nPath: rpc-mode.ts\n\n@@ -1,2 +1,3 @@\n a\n+b");
	});

	test("formats a comment item with anchor snapshot", () => {
		const item: CommentContextItem = {
			kind: "comment",
			text: "这里是不是有重复创建 runtime 的问题？",
			anchor: { type: "file", path: "C:/work/runtime.ts", startLine: 210, endLine: 228 },
			anchorText: "line-210\nline-211",
			anchorHash: "hash",
			snapshotAt: 0,
		};
		const { text } = formatContextItemsForPrompt([item], "C:/work");
		expect(text).toContain("[User comment]");
		expect(text).toContain("Path: runtime.ts");
		expect(text).toContain("Lines: lines 210-228");
		expect(text).toContain("Comment:\n这里是不是有重复创建 runtime 的问题？");
		expect(text).toContain("Anchored content:\nline-210\nline-211");
	});

	test("multiple items are joined and summarized", () => {
		const file: FileContextItem = {
			kind: "file",
			path: "C:/work/a.ts",
			lines: [{ lineNumber: 1, text: "a" }],
			contentText: "a",
			contentHash: "h1",
			truncated: false,
			lineCount: 1,
			snapshotAt: 0,
		};
		const comment: CommentContextItem = {
			kind: "comment",
			text: "why?",
			anchor: { type: "file", path: "C:/work/a.ts", startLine: 1, endLine: 1 },
			anchorText: "a",
			anchorHash: "h2",
			snapshotAt: 0,
		};
		const { text, summaries } = formatContextItemsForPrompt([file, comment], "C:/work");
		expect(text).toContain("[File context]");
		expect(text).toContain("[User comment]");
		expect(summaries).toHaveLength(2);
	});

	test("context attachment custom type is stable", () => {
		expect(CONTEXT_ATTACHMENT_CUSTOM_TYPE).toBe("context_attachment");
	});
});

describe("validateContextItems", () => {
	test("valid file snapshot passes", async () => {
		const dir = makeTempDir();
		const item = await fileItem(dir, "ok.ts", "a\nb\nc\n", { startLine: 1, endLine: 3 });
		const result = await validateContextItems([item], dir);
		expect(result).toEqual({ ok: true });
	});

	test("file changed after snapshot -> stale", async () => {
		const dir = makeTempDir();
		const item = await fileItem(dir, "stale.ts", "a\nb\nc\n");
		// The file changes after the user added it to context.
		writeFileSync(join(dir, "stale.ts"), "a\nCHANGED\nc\n", "utf-8");
		const result = await validateContextItems([item], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("stale");
		expect(result.staleIndexes).toEqual([0]);
	});

	test("unchanged file still validates after other items changed", async () => {
		const dir = makeTempDir();
		const good = await fileItem(dir, "good.ts", "x\n");
		const bad = await fileItem(dir, "bad.ts", "y\n");
		writeFileSync(join(dir, "bad.ts"), "y-CHANGED\n", "utf-8");
		const result = await validateContextItems([good, bad], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.staleIndexes).toEqual([1]);
	});

	test("missing file after snapshot -> invalid", async () => {
		const dir = makeTempDir();
		const item = await fileItem(dir, "gone.ts", "x\n");
		rmSync(join(dir, "gone.ts"));
		const result = await validateContextItems([item], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid");
	});

	test("malformed range payload is rejected (host is not trusted)", async () => {
		const dir = makeTempDir();
		const item = await fileItem(dir, "range.ts", "a\nb\n");
		const tampered: FileContextItem = { ...item, startLine: 0, endLine: 5 };
		const result = await validateContextItems([tampered], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid");
	});

	test("tampered content text (hash mismatch) is rejected even if path is valid", async () => {
		const dir = makeTempDir();
		const item = await fileItem(dir, "trusted.ts", "real content\n");
		const tampered: FileContextItem = { ...item, contentText: "completely unrelated text", contentHash: "deadbeef" };
		const result = await validateContextItems([tampered], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("stale");
	});

	test("diff snapshot validates and detects changes", async () => {
		const dir = makeTempDir();
		initRepo(dir);
		writeFileSync(join(dir, "diffme.ts"), "a\nb\nc\n", "utf-8");
		commitAll(dir, "initial");
		writeFileSync(join(dir, "diffme.ts"), "a\nB\nc\n", "utf-8");

		const diffResult = await getFileDiff({ path: "diffme.ts", cwd: dir });
		expect(diffResult.ok).toBe(true);
		if (!diffResult.ok || diffResult.diff.status !== "diff") return;
		const item: DiffContextItem = {
			kind: "diff",
			path: join(dir, "diffme.ts"),
			diff: diffResult.diff,
			snapshotAt: Date.now(),
		};

		const ok = await validateContextItems([item], dir);
		expect(ok).toEqual({ ok: true });

		// Change the file again -> stale.
		writeFileSync(join(dir, "diffme.ts"), "a\nB\nC\n", "utf-8");
		const stale = await validateContextItems([item], dir);
		expect(stale.ok).toBe(false);
		if (stale.ok) return;
		expect(stale.code).toBe("stale");
		expect(stale.staleIndexes).toEqual([0]);
	});

	test("comment with file anchor validates and detects stale anchors", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "comment.ts"), "one\ntwo\nthree\n", "utf-8");
		const anchor = await getFilePreview({ path: join(dir, "comment.ts"), cwd: dir, startLine: 2, endLine: 2 });
		expect(anchor.ok).toBe(true);
		if (!anchor.ok) return;
		const comment: CommentContextItem = {
			kind: "comment",
			text: "check this",
			anchor: { type: "file", path: join(dir, "comment.ts"), startLine: 2, endLine: 2 },
			anchorText: anchor.preview.contentText,
			anchorHash: anchor.preview.contentHash,
			snapshotAt: Date.now(),
		};

		const ok = await validateContextItems([comment], dir);
		expect(ok).toEqual({ ok: true });

		// The anchored line changes -> the comment must not silently re-anchor.
		writeFileSync(join(dir, "comment.ts"), "one\nTWO-CHANGED\nthree\n", "utf-8");
		const stale = await validateContextItems([comment], dir);
		expect(stale.ok).toBe(false);
		if (stale.ok) return;
		expect(stale.code).toBe("stale");
	});

	test("empty comment text is rejected", async () => {
		const dir = makeTempDir();
		const comment: CommentContextItem = {
			kind: "comment",
			text: "   ",
			anchor: { type: "file", path: join(dir, "x.ts"), startLine: 1, endLine: 1 },
			anchorText: "x",
			anchorHash: "hash",
			snapshotAt: 0,
		};
		const result = await validateContextItems([comment], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid");
	});

	test("oversized content text is rejected", async () => {
		const dir = makeTempDir();
		const item = await fileItem(dir, "big.ts", "x\n");
		const oversized: FileContextItem = { ...item, contentText: "x".repeat(1024 * 1024 + 1), contentHash: "tampered" };
		const result = await validateContextItems([oversized], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid");
	});

	test("file context for a binary file is rejected at validation", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
		const preview = await previewFile({ path: join(dir, "blob.bin"), cwd: dir });
		expect(preview.ok).toBe(false);
		if (preview.ok) return;
		expect(preview.code).toBe("binary");

		const fake: FileContextItem = {
			kind: "file",
			path: join(dir, "blob.bin"),
			lines: [],
			contentText: "",
			contentHash: "",
			truncated: false,
			lineCount: 0,
			snapshotAt: 0,
		};
		const result = await validateContextItems([fake], dir);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid");
	});
});
