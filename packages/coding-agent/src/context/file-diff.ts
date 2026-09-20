/**
 * Core File Diff service (Task 9).
 *
 * Hosts (Desktop) request "diff for this file" through this single Core
 * capability. The diff always comes from the real Git layer (`git diff HEAD`),
 * never from guessed base content. Structured hunks with real old/new line
 * numbers are parsed from Git's unified output so the Desktop can anchor
 * selections and comments to real lines.
 *
 * Only serialization-safe facts are returned (status, hunks, unified text,
 * hash). No rendered markup.
 */

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { inspectGitRepository, runGit } from "../git/repository/integration.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../utils/paths.ts";
import { BINARY_SNIFF_BYTES, isBinaryBuffer } from "./file-presentation.ts";

/** Hard cap on files considered for diffing. */
export const MAX_DIFF_FILE_BYTES = 4 * 1024 * 1024;
/** Hard cap on diff text returned to hosts (truncated structurally). */
export const MAX_DIFF_LINES = 2000;

export type FileDiffErrorCode = "not_found" | "not_file" | "binary" | "too_large" | "internal";

export type FileDiffLineKind = "context" | "add" | "remove" | "marker";

export interface FileDiffLine {
	kind: FileDiffLineKind;
	/** 1-based old-file line (context/remove). */
	oldLine?: number;
	/** 1-based new-file line (context/add). */
	newLine?: number;
	text: string;
}

export interface FileDiffHunk {
	/** Stable index within the diff (0-based). */
	index: number;
	/** Original hunk header, e.g. `@@ -1,5 +1,6 @@`. */
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: FileDiffLine[];
}

export interface FileDiffBase {
	path: string;
	resolvedPath: string;
	displayPath: string;
	cwd: string;
}

export type FileDiff =
	| (FileDiffBase & { status: "no_changes" })
	| (FileDiffBase & { status: "untracked" })
	| (FileDiffBase & { status: "unavailable"; reason: "not_git_repository" | "no_baseline" | "outside_repository" })
	| (FileDiffBase & {
			status: "diff";
			/** Unified diff text the model/host sees (hunk headers + lines). */
			unified: string;
			/** sha256 of `unified` (context snapshot provenance). */
			diffHash: string;
			hunks: FileDiffHunk[];
			truncated: boolean;
			snapshotAt: number;
	  });

export type FileDiffResult = { ok: true; diff: FileDiff } | { ok: false; code: FileDiffErrorCode; message: string };

export interface FileDiffParams {
	path: string;
	cwd: string;
}

// ---------------------------------------------------------------------------
// Unified diff parsing (Git output)
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a standard unified diff (as produced by `git diff`) into structured
 * hunks with real old/new line numbers.
 *
 * Handles:
 * - hunk headers with optional counts (`-0,0` new file / `+0,0` deletion)
 * - context (` `), removal (`-`), addition (`+`) lines
 * - `\ No newline at end of file` markers
 * - non-hunk preamble lines (diff --git / index / --- / +++ / Binary files)
 */
export function parseUnifiedDiff(text: string): FileDiffHunk[] {
	const hunks: FileDiffHunk[] = [];
	let current: FileDiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;

	for (const rawLine of text.split("\n")) {
		const match = HUNK_HEADER_RE.exec(rawLine);
		if (match) {
			const oldStart = Number(match[1]);
			const oldCount = match[2] !== undefined ? Number(match[2]) : 1;
			const newStart = Number(match[3]);
			const newCount = match[4] !== undefined ? Number(match[4]) : 1;
			current = {
				index: hunks.length,
				header: rawLine,
				oldStart,
				oldLines: oldCount,
				newStart,
				newLines: newCount,
				lines: [],
			};
			hunks.push(current);
			oldLine = oldStart;
			newLine = newStart;
			continue;
		}

		if (!current) continue; // preamble before the first hunk

		if (rawLine.startsWith("\\")) {
			// "\ No newline at end of file"
			current.lines.push({ kind: "marker", text: rawLine.slice(1) });
			continue;
		}

		const marker = rawLine.charAt(0);
		if (marker === " ") {
			current.lines.push({ kind: "context", oldLine, newLine, text: rawLine.slice(1) });
			oldLine += 1;
			newLine += 1;
		} else if (marker === "-") {
			current.lines.push({ kind: "remove", oldLine, text: rawLine.slice(1) });
			oldLine += 1;
		} else if (marker === "+") {
			current.lines.push({ kind: "add", newLine, text: rawLine.slice(1) });
			newLine += 1;
		}
		// Anything else inside a hunk is ignored defensively.
	}

	return hunks;
}

/** Rebuild a unified diff text from parsed hunks (bounded, hash-stable). */
export function buildUnifiedText(hunks: FileDiffHunk[]): string {
	const parts: string[] = [];
	for (const hunk of hunks) {
		parts.push(hunk.header);
		for (const line of hunk.lines) {
			const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "marker" ? "\\" : " ";
			parts.push(`${marker}${line.text}`);
		}
	}
	return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Diff service
// ---------------------------------------------------------------------------

async function sniffBinary(resolvedPath: string): Promise<boolean> {
	try {
		const fd = await open(resolvedPath, "r");
		try {
			const buffer = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
			const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
			return bytesRead > 0 && isBinaryBuffer(buffer.subarray(0, bytesRead));
		} finally {
			await fd.close();
		}
	} catch {
		return false;
	}
}

export async function getFileDiff(params: FileDiffParams): Promise<FileDiffResult> {
	const { path, cwd } = params;
	const resolvedPath = resolveToCwd(path, cwd);
	const base: FileDiffBase = {
		path,
		resolvedPath,
		displayPath: formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd),
		cwd,
	};

	try {
		const fileStat = await stat(resolvedPath);
		if (fileStat.isDirectory()) {
			return { ok: false, code: "not_file", message: `Is a directory: ${base.displayPath}` };
		}
		if (fileStat.size > MAX_DIFF_FILE_BYTES) {
			return {
				ok: false,
				code: "too_large",
				message: `File is too large to diff (${fileStat.size} bytes exceeds the ${MAX_DIFF_FILE_BYTES}-byte limit).`,
			};
		}
		if (await sniffBinary(resolvedPath)) {
			return { ok: false, code: "binary", message: "Binary file diff is not supported." };
		}
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { ok: false, code: "not_found", message: `File not found: ${base.displayPath}` };
		}
		return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
	}

	const repo = inspectGitRepository(cwd);
	if (!repo.gitAvailable) {
		return { ok: true, diff: { ...base, status: "unavailable", reason: "not_git_repository" } };
	}
	if (!repo.isRepository || !repo.root) {
		return { ok: true, diff: { ...base, status: "unavailable", reason: "not_git_repository" } };
	}
	if (!repo.hasBaseline) {
		return { ok: true, diff: { ...base, status: "unavailable", reason: "no_baseline" } };
	}

	const repoRoot = repo.root;
	const repoRelative = relative(repoRoot, resolvedPath);
	if (repoRelative === "" || isAbsolute(repoRelative) || repoRelative.startsWith("..")) {
		return { ok: true, diff: { ...base, status: "unavailable", reason: "outside_repository" } };
	}

	// Tracked? (`git ls-files` lists index entries; untracked files are absent.)
	const tracked = runGit(repoRoot, ["ls-files", "--", repoRelative]);
	if (!tracked.ok || tracked.stdout.trim().length === 0) {
		return { ok: true, diff: { ...base, status: "untracked" } };
	}

	const diffResult = runGit(repoRoot, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", repoRelative]);
	if (!diffResult.ok) {
		return {
			ok: false,
			code: "internal",
			message: diffResult.error || diffResult.stderr || "git diff failed",
		};
	}

	const stdout = diffResult.stdout;
	if (stdout.trim().length === 0) {
		return { ok: true, diff: { ...base, status: "no_changes" } };
	}
	if (stdout.includes("Binary files ")) {
		return { ok: false, code: "binary", message: "Binary file diff is not supported." };
	}

	let hunks = parseUnifiedDiff(stdout);
	let truncated = false;
	if (hunks.length > 0) {
		let keptLines = 0;
		const kept: FileDiffHunk[] = [];
		for (const hunk of hunks) {
			if (keptLines + hunk.lines.length > MAX_DIFF_LINES) {
				truncated = true;
				break;
			}
			kept.push(hunk);
			keptLines += hunk.lines.length;
		}
		hunks = kept;
	} else {
		// No parseable hunks (unexpected output): refuse rather than mislead.
		return { ok: false, code: "internal", message: "git diff produced unparseable output." };
	}

	const unified = buildUnifiedText(hunks);
	return {
		ok: true,
		diff: {
			...base,
			status: "diff",
			unified,
			diffHash: hashText(unified),
			hunks,
			truncated,
			snapshotAt: Date.now(),
		},
	};
}
