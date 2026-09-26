import { existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import { GIT_COMMIT_TIMEOUT_MS, runGit } from "./integration.ts";

/**
 * Discard every uncommitted change and return the repository to HEAD.
 *
 * Used only by the explicit /restore command after the user confirmed the
 * preview. Tracked files are reset with `git reset --hard HEAD`; untracked
 * files and directories (not ignored ones) are deleted. Untracked paths are
 * removed by MyHarness instead of `git clean` because Git on Windows cannot
 * delete reserved device names such as `nul`. Nested repositories and
 * protected paths (the MyHarness agent directory) are never deleted.
 */

export interface DiscardChangesPreview {
	repositoryRoot: string;
	headCommit: string;
	/** Short hash and subject of HEAD, for display. */
	headLabel: string;
	/** `git status --porcelain` lines for tracked changes. */
	trackedChanges: string[];
	/** Repository-relative untracked paths that will be deleted (directories end with `/`). */
	untrackedPaths: string[];
	/** Untracked nested repositories that are kept. */
	keptNestedRepositories: string[];
}

export interface DiscardChangesResult {
	ok: boolean;
	error?: string;
	removedPaths: string[];
	failedPaths: Array<{ path: string; error: string }>;
}

function toFileSystemPath(absolutePath: string): string {
	// The verbatim prefix lets Windows address names such as `nul` or `con`
	// as real files instead of devices.
	return process.platform === "win32" ? `\\\\?\\${path.resolve(absolutePath)}` : absolutePath;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listUntracked(
	repositoryRoot: string,
	protectedPaths: readonly string[],
): { paths?: string[]; nested?: string[]; error?: string } {
	const result = runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "--directory", "-z"]);
	if (!result.ok) return { error: result.stderr || result.error || "无法列出未跟踪文件。" };
	const paths: string[] = [];
	const nested: string[] = [];
	for (const entry of result.stdout.split("\0").filter(Boolean)) {
		const absolutePath = path.join(repositoryRoot, entry);
		if (
			protectedPaths.some(
				(protectedPath) => isInside(absolutePath, protectedPath) || isInside(protectedPath, absolutePath),
			)
		) {
			continue;
		}
		if (entry.endsWith("/") && existsSync(path.join(absolutePath, ".git"))) {
			nested.push(entry);
			continue;
		}
		paths.push(entry);
	}
	return { paths, nested };
}

export function previewDiscardChanges(
	repositoryRoot: string,
	options: { protectedPaths?: string[] } = {},
): { preview?: DiscardChangesPreview; error?: string } {
	const head = runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (!head.ok || !head.stdout) return { error: "仓库还没有任何提交，无法退回。" };
	const label = runGit(repositoryRoot, ["log", "-1", "--format=%h %s", head.stdout]);
	const status = runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
	if (!status.ok) return { error: status.stderr || status.error || "无法读取已跟踪文件的改动。" };
	const untracked = listUntracked(repositoryRoot, options.protectedPaths ?? []);
	if (!untracked.paths) return { error: untracked.error };
	return {
		preview: {
			repositoryRoot,
			headCommit: head.stdout,
			headLabel: label.ok && label.stdout ? label.stdout : head.stdout.slice(0, 7),
			trackedChanges: status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [],
			untrackedPaths: untracked.paths,
			keptNestedRepositories: untracked.nested ?? [],
		},
	};
}

export function hasChangesToDiscard(preview: DiscardChangesPreview): boolean {
	return preview.trackedChanges.length > 0 || preview.untrackedPaths.length > 0;
}

/**
 * Apply a confirmed preview. Refuses when HEAD moved since the preview, and
 * only deletes untracked paths that were shown to the user and still exist.
 */
export function discardChangesToHead(
	preview: DiscardChangesPreview,
	options: { protectedPaths?: string[] } = {},
): DiscardChangesResult {
	const { repositoryRoot } = preview;
	const head = runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (!head.ok || head.stdout !== preview.headCommit) {
		return {
			ok: false,
			error: "确认之后最新提交已经变化，已取消退回。请重新执行 /restore。",
			removedPaths: [],
			failedPaths: [],
		};
	}

	const current = listUntracked(repositoryRoot, options.protectedPaths ?? []);
	if (!current.paths) return { ok: false, error: current.error, removedPaths: [], failedPaths: [] };

	const reset = runGit(repositoryRoot, ["reset", "--hard", "--quiet", preview.headCommit], GIT_COMMIT_TIMEOUT_MS);
	if (!reset.ok) {
		return {
			ok: false,
			error: reset.stderr || reset.error || "git reset --hard 执行失败。",
			removedPaths: [],
			failedPaths: [],
		};
	}

	const confirmed = new Set(preview.untrackedPaths);
	const removedPaths: string[] = [];
	const failedPaths: Array<{ path: string; error: string }> = [];
	for (const entry of current.paths) {
		if (!confirmed.has(entry)) continue;
		const absolutePath = path.join(repositoryRoot, entry);
		if (!isInside(repositoryRoot, absolutePath)) continue;
		try {
			rmSync(toFileSystemPath(absolutePath), { recursive: true, force: true });
			removedPaths.push(entry);
		} catch (error) {
			failedPaths.push({ path: entry, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ok: failedPaths.length === 0, removedPaths, failedPaths };
}
