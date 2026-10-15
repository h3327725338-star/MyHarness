import { resolve } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, runGit } from "./command.ts";

/**
 * `git status` 短 TTL 缓存与并发去重。
 *
 * - 高频只读轮询（checkpoint pending 路径、任务改动判断）走缓存，避免在
 *   大仓库里反复派生 `git status` 子进程阻塞事件循环。
 * - 关键写操作（提交、丢弃、恢复）必须用 `fresh: true` 绕过缓存，写完成后
 *   调用 `invalidateGitStatusCache()` 失效；缓存本身永不吞错误，失败结果
 *   不入缓存，直接返回给调用方。
 */

export interface GitPorcelainEntry {
	code: string;
	path: string;
}

export interface CachedGitStatusResult {
	entries?: GitPorcelainEntry[];
	output?: string;
	error?: string;
}

export interface CachedGitStatusOptions {
	/** 为 true 时绕过缓存强制读取最新状态（关键写操作/恢复决策前使用）。 */
	fresh?: boolean;
	signal?: AbortSignal;
}

/** 短 TTL：只合并高频轮询的重复读取，写入侧靠显式失效保证准确性。 */
export const GIT_STATUS_CACHE_TTL_MS = 1_000;

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;

interface CacheEntry {
	expiresAt: number;
	entries: GitPorcelainEntry[];
	output: string;
	version: number;
}

interface InflightEntry {
	promise: Promise<CachedGitStatusResult>;
	version: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, InflightEntry>();
const versions = new Map<string, number>();

/** 仅供测试观察的底层 Git 调用计数（缓存命中与并发合并不会增加它）。 */
let underlyingCalls = 0;

/** 测试读取底层调用计数；生产代码不依赖它。 */
export function getGitStatusUnderlyingCallCount(): number {
	return underlyingCalls;
}

/** 测试重置底层调用计数与缓存内容；生产代码不调用它。 */
export function resetGitStatusCacheForTests(): void {
	cache.clear();
	inflight.clear();
	versions.clear();
	underlyingCalls = 0;
}

function cacheKey(repositoryRoot: string): string {
	const resolved = resolve(repositoryRoot);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parsePorcelainV1Z(value: string): GitPorcelainEntry[] {
	const tokens = value.split("\0");
	const entries: GitPorcelainEntry[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token || token.length < 4) continue;
		const code = token.slice(0, 2);
		const path = token.slice(3);
		if (path) entries.push({ code, path });
		if (code.includes("R") || code.includes("C")) {
			const originalPath = tokens[index + 1];
			if (originalPath) {
				entries.push({ code: `${code[0]}${code[1]}`, path: originalPath });
				index++;
			}
		}
	}
	return entries;
}

function formatFailure(args: readonly string[], result: { error?: string; stderr?: string }): string {
	const details = [result.error, result.stderr].filter((value): value is string => Boolean(value?.trim()));
	return details.length > 0 ? details.join("\n") : `Git 命令执行失败：git ${args.join(" ")}`;
}

async function readFreshStatus(
	repositoryRoot: string,
	key: string,
	version: number,
	signal?: AbortSignal,
): Promise<CachedGitStatusResult> {
	underlyingCalls++;
	const result = await runGit([...STATUS_ARGS], {
		cwd: repositoryRoot,
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
		env: { GIT_OPTIONAL_LOCKS: "0" },
		signal,
	});
	if (!result.ok) {
		// 失败不入缓存：下一次读取重试，而不是把错误冻住一个 TTL。
		if (inflight.get(key)?.version === version) inflight.delete(key);
		return { error: formatFailure(STATUS_ARGS, result) };
	}
	const entries = parsePorcelainV1Z(result.stdout);
	const fresh: CacheEntry = {
		expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
		entries,
		output: result.stdout,
		version,
	};
	// 读取期间若发生过写入失效（version 已推进），丢弃这次可能陈旧的结果。
	const current = versions.get(key) ?? 0;
	if (current === version) {
		cache.set(key, fresh);
	}
	while (cache.size > 64) cache.delete(cache.keys().next().value!);
	if (inflight.get(key)?.version === version) inflight.delete(key);
	return { entries, output: result.stdout };
}

/**
 * 读取仓库 `git status`（porcelain v1 -z 全量 untracked）。
 * 默认命中 TTL 内缓存；并发的相同读取合并为一次底层调用。
 * 从不抛 Git 失败：失败以 `{ error }` 返回且不入缓存。
 */
export function getCachedGitStatus(
	repositoryRoot: string,
	options: CachedGitStatusOptions = {},
): Promise<CachedGitStatusResult> {
	const key = cacheKey(repositoryRoot);
	// A caller-owned cancellation must not cancel another consumer's shared read.
	if (options.signal) {
		const version = (versions.get(key) ?? 0) + 1;
		versions.set(key, version);
		return readFreshStatus(repositoryRoot, key, version, options.signal);
	}
	if (!options.fresh) {
		const hit = cache.get(key);
		if (hit && hit.expiresAt > Date.now()) {
			return Promise.resolve({ entries: hit.entries, output: hit.output });
		}
		const ongoing = inflight.get(key);
		if (ongoing) return ongoing.promise;
	}
	const version = (versions.get(key) ?? 0) + 1;
	versions.set(key, version);
	// Critical fresh reads must start after the decision point, not join an older in-flight status.
	const promise = readFreshStatus(repositoryRoot, key, version, options.signal);
	inflight.set(key, { promise, version });
	return promise;
}

/**
 * 写入操作完成后失效对应仓库（或全部）的缓存。
 * 只删内存快照，不读写任何持久化数据；单纯的失效永不失败。
 */
export function invalidateGitStatusCache(repositoryRoot?: string): void {
	if (repositoryRoot === undefined) {
		cache.clear();
		for (const key of inflight.keys()) versions.set(key, (versions.get(key) ?? 0) + 1);
		inflight.clear();
		return;
	}
	const key = cacheKey(repositoryRoot);
	cache.delete(key);
	versions.set(key, (versions.get(key) ?? 0) + 1);
	inflight.delete(key);
}
