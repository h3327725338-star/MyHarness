import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { runGit } from "../../git/repository/command.ts";
import { invalidateGitReadCache } from "../../git/repository/read-cache.ts";
import type { ReviewChange } from "../../git/repository/review-types.ts";
import type { FileChangeSummary } from "./changes.ts";

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const WORKTREE_CACHE_TTL_MS = 2000;

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") count++;
	}
	if (!text.endsWith("\n")) count++;
	return count;
}

export function looksBinary(buffer: Buffer): boolean {
	const length = Math.min(buffer.length, 8000);
	for (let index = 0; index < length; index++) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

export function parseNumstatZ(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
	const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
	if (!output) return map;
	const parts = output.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) continue;
		const tab1 = entry.indexOf("\t");
		if (tab1 === -1) continue;
		const tab2 = entry.indexOf("\t", tab1 + 1);
		if (tab2 === -1) continue;
		const addStr = entry.slice(0, tab1);
		const delStr = entry.slice(tab1 + 1, tab2);
		const pathPart = entry.slice(tab2 + 1);
		const isBinary = addStr === "-" && delStr === "-";
		const additions = isBinary ? 0 : Number.parseInt(addStr, 10) || 0;
		const deletions = isBinary ? 0 : Number.parseInt(delStr, 10) || 0;

		let filePath = pathPart;
		if (filePath === "" && i + 2 < parts.length) {
			const _oldPath = parts[++i];
			const newPath = parts[++i];
			filePath = newPath;
		}
		if (filePath) {
			map.set(filePath, { additions, deletions, binary: isBinary });
		}
	}
	return map;
}

async function batchWorktreeStatsUncached(
	repositoryRoot: string,
	cwd: string,
	changes: readonly ReviewChange[],
	diffSingleFile?: (repoRoot: string, change: ReviewChange) => Promise<{ summary: FileChangeSummary; patch?: string }>,
): Promise<FileChangeSummary[]> {
	const results = new Map<string, FileChangeSummary>();
	const needsDiff: string[] = [];
	const repoPathToChangePath = new Map<string, string>();

	for (const change of changes) {
		const summary: FileChangeSummary = {
			path: change.path,
			status: change.status,
			...(change.oldPath ? { oldPath: change.oldPath } : {}),
			additions: 0,
			deletions: 0,
			binary: false,
		};
		results.set(change.path, summary);

		const absPath = path.resolve(cwd, change.path);

		// Untracked / added files: directly count lines from disk without git subprocess
		if (change.status === "added") {
			if (!existsSync(absPath)) continue;
			try {
				const stat = statSync(absPath);
				if (!stat.isFile()) continue;
				if (stat.size > MAX_TEXT_BYTES) {
					summary.unavailable = "File is larger than 2 MB; content diff skipped.";
					continue;
				}
				const buf = readFileSync(absPath);
				if (looksBinary(buf)) {
					summary.binary = true;
					continue;
				}
				summary.additions = countLines(buf.toString("utf8"));
			} catch {}
			continue;
		}

		// Renamed files: fall back to single-file diff to guarantee exact rename diff
		if (change.status === "renamed" && diffSingleFile) {
			const res = await diffSingleFile(repositoryRoot, change);
			results.set(change.path, res.summary);
			continue;
		}

		// Check if larger than 2MB on disk
		if (change.status !== "deleted" && existsSync(absPath)) {
			try {
				const stat = statSync(absPath);
				if (stat.isFile() && stat.size > MAX_TEXT_BYTES) {
					summary.unavailable = "File is larger than 2 MB; content diff skipped.";
					continue;
				}
			} catch {}
		}

		// Map to repositoryRoot relative path for git diff
		const relToRepo = path.relative(path.resolve(repositoryRoot), absPath).split(path.sep).join("/");
		needsDiff.push(relToRepo);
		repoPathToChangePath.set(relToRepo, change.path);
	}

	// Batch git diff in chunks <= 100
	const CHUNK_SIZE = 100;
	for (let i = 0; i < needsDiff.length; i += CHUNK_SIZE) {
		const chunk = needsDiff.slice(i, i + CHUNK_SIZE);
		const gitRes = await runGit(["diff", "--numstat", "-z", "HEAD", "--", ...chunk], {
			cwd: repositoryRoot,
			timeoutMs: 30_000,
			env: { GIT_OPTIONAL_LOCKS: "0" },
		});
		if (gitRes.ok) {
			const parsed = parseNumstatZ(gitRes.stdout);
			for (const [repoPath, stat] of parsed.entries()) {
				const origPath = repoPathToChangePath.get(repoPath) ?? repoPath;
				const summary = results.get(origPath);
				if (summary) {
					if (stat.binary) {
						summary.binary = true;
					} else {
						summary.additions = stat.additions;
						summary.deletions = stat.deletions;
					}
				}
			}
		}
	}

	return changes.map((c) => results.get(c.path)!);
}

export interface WorktreeCacheData {
	repositoryRoot?: string;
	changes: ReviewChange[];
	changesByPath: Map<string, ReviewChange>;
	files?: FileChangeSummary[];
	error?: string;
	cachedAt: number;
	version: number;
}

const worktreeCaches = new Map<string, WorktreeCacheData>();
const worktreeVersions = new Map<string, number>();

function normalizeCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface WorktreeListResult {
	repositoryRoot?: string;
	changes: ReviewChange[];
	error?: string;
	/** Generation captured before the read; stale completions must not repopulate the shared cache. */
	cacheVersion?: number;
}

/** 同 checkout 列表读取的在途合并：并发未命中只派生一次 Git 进程。失败不缓存，结果按版本守卫写回。 */
const worktreeListInflight = new Map<
	string,
	{ promise: Promise<WorktreeListResult>; version: number; fresh: boolean }
>();

export function coalescedWorktreeListFetch(
	cwd: string,
	fetcher: () => Promise<WorktreeListResult>,
	options: { fresh?: boolean } = {},
): Promise<WorktreeListResult> {
	const key = normalizeCwd(cwd);
	const ongoing = worktreeListInflight.get(key);
	// An explicit refresh cannot join an older ordinary read. Concurrent refreshes share their own generation.
	if (ongoing && (!options.fresh || ongoing.fresh)) return ongoing.promise;
	if (options.fresh) bumpWorktreeVersion(cwd);
	const version = getWorktreeVersion(cwd);
	const promise = (async (): Promise<WorktreeListResult> => {
		try {
			const result = { ...(await fetcher()), cacheVersion: version };
			if (getWorktreeVersion(cwd) === version && !result.error) setCachedWorktreeChanges(cwd, result);
			return result;
		} finally {
			if (worktreeListInflight.get(key)?.version === version) worktreeListInflight.delete(key);
		}
	})();
	worktreeListInflight.set(key, { promise, version, fresh: !!options.fresh });
	return promise;
}

/** 并发相同批量统计只执行一次 Git `diff --numstat`，等待者各拿一份浅拷贝（只读使用）。 */
const batchStatsInflight = new Map<string, Promise<FileChangeSummary[]>>();

function batchStatsInflightKey(
	repositoryRoot: string,
	cwd: string,
	changes: readonly ReviewChange[],
): string | undefined {
	const signature = changes.map((change) => `${change.status}\0${change.path}\0${change.oldPath ?? ""}`).join("\0");
	if (signature.length > 8192) return undefined;
	return `batch\0${normalizeCwd(repositoryRoot)}\0${normalizeCwd(cwd)}\0${getWorktreeVersion(cwd)}\0${signature}`;
}

export async function batchWorktreeStats(
	repositoryRoot: string,
	cwd: string,
	changes: readonly ReviewChange[],
	diffSingleFile?: (repoRoot: string, change: ReviewChange) => Promise<{ summary: FileChangeSummary; patch?: string }>,
): Promise<FileChangeSummary[]> {
	const key = batchStatsInflightKey(repositoryRoot, cwd, changes);
	if (key !== undefined) {
		const ongoing = batchStatsInflight.get(key);
		if (ongoing) return ongoing.then((files) => [...files]);
		const promise = batchWorktreeStatsUncached(repositoryRoot, cwd, changes, diffSingleFile);
		batchStatsInflight.set(key, promise);
		try {
			const files = await promise;
			return [...files];
		} finally {
			if (batchStatsInflight.get(key) === promise) batchStatsInflight.delete(key);
		}
	}
	return batchWorktreeStatsUncached(repositoryRoot, cwd, changes, diffSingleFile);
}

export function getWorktreeVersion(cwd: string): number {
	const key = normalizeCwd(cwd);
	return worktreeVersions.get(key) ?? 0;
}

export function bumpWorktreeVersion(cwd: string): number {
	const key = normalizeCwd(cwd);
	const next = (worktreeVersions.get(key) ?? 0) + 1;
	worktreeVersions.set(key, next);
	worktreeCaches.delete(key);
	// 失效后新读取不再加入旧的在途查询；在途完成靠版本守卫丢弃，不覆盖新状态。
	worktreeListInflight.delete(key);
	return next;
}

export function invalidateWorktreeCache(cwd?: string): void {
	invalidateGitReadCache(cwd);
	if (cwd) {
		bumpWorktreeVersion(cwd);
	} else {
		for (const key of new Set([
			...worktreeVersions.keys(),
			...worktreeListInflight.keys(),
			...worktreeCaches.keys(),
		])) {
			worktreeVersions.set(key, (worktreeVersions.get(key) ?? 0) + 1);
		}
		worktreeCaches.clear();
		worktreeListInflight.clear();
	}
}

export function getCachedWorktreeChangesSync(cwd: string): WorktreeCacheData | undefined {
	const key = normalizeCwd(cwd);
	const entry = worktreeCaches.get(key);
	if (!entry) return undefined;
	const currentVer = worktreeVersions.get(key) ?? 0;
	if (entry.version !== currentVer) {
		worktreeCaches.delete(key);
		return undefined;
	}
	if (Date.now() - entry.cachedAt > WORKTREE_CACHE_TTL_MS) {
		worktreeCaches.delete(key);
		return undefined;
	}
	return entry;
}

export function setCachedWorktreeChanges(
	cwd: string,
	data: {
		repositoryRoot?: string;
		changes: ReviewChange[];
		files?: FileChangeSummary[];
		error?: string;
		cacheVersion?: number;
	},
): WorktreeCacheData {
	const key = normalizeCwd(cwd);
	const version = data.cacheVersion ?? worktreeVersions.get(key) ?? 0;
	const changesByPath = new Map<string, ReviewChange>();
	for (const change of data.changes) {
		if (change?.path && !changesByPath.has(change.path)) {
			changesByPath.set(change.path, change);
		}
	}
	const entry: WorktreeCacheData = {
		repositoryRoot: data.repositoryRoot,
		changes: data.changes,
		changesByPath,
		files: data.files,
		error: data.error,
		cachedAt: Date.now(),
		version,
	};
	if (!data.error && getWorktreeVersion(cwd) === version) {
		worktreeCaches.set(key, entry);
		while (worktreeCaches.size > 128) worktreeCaches.delete(worktreeCaches.keys().next().value!);
	}
	return entry;
}
