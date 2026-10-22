import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveGitRepositoryRoot } from "../../utils/paths.ts";
import { type GitBranchListResult, listLocalBranchesAsync } from "./branches.ts";
import { type GitCommandResult, runGit } from "./command.ts";
import type { GitIdentity, GitRepositoryState, GitStatusPreview } from "./integration.ts";

/**
 * 同 checkout Git 只读查询的短 TTL 缓存与在途合并。
 *
 * 合并的重复查询（都按 checkout 键隔离，同一 `cwd`/`root` 共享）：
 * - `git --version`：进程级复用，Git 二进制版本几乎不变，TTL 5 分钟；
 * - 仓库检查（`rev-parse --show-toplevel` + `rev-parse --verify HEAD` + `branch --show-current`）：TTL 2 秒；
 * - 身份（4 条 `config --get`）：TTL 10 秒；
 * - 状态预览（`status --short`）：TTL 1 秒，与 `status-cache.ts` 同一口径；
 * - HEAD（`log -1`）：TTL 2 秒；
 * - Git 目录布局（`rev-parse --absolute-git-dir --git-common-dir`，推导 linked worktree）：TTL 60 秒。
 *
 * 保证：
 * - `fresh: true` 强制重验：绕过缓存、不加入旧的普通查询；并发强制刷新共享新批次（读完按版本守卫写回）；
 * - 在途合并：同一 key 的并发读取共享同一个 Promise，只派生一次 Git 进程；
 * - 不同 checkout/Worktree 隔离：key 都是 resolve 后的绝对路径（Windows 下小写），不同路径永不共享；
 * - 失败不缓存：传输类失败（spawn/timeout/cancelled）以及预览/HEAD/目录读取的任何失败都不入缓存，下次重试；
 *   仓库检查里“命令正常返回但判定为非仓库”（exit 失败）是有效状态，按同样短 TTL 缓存，外部 `git init` 最多一个 TTL 后可见；
 * - 旧请求不覆盖新结果：每次读取/失效都推进 key 的版本号，完成时版本已推进则丢弃本次结果；
 * - 带调用方 signal 的读取走隔离直读，不取消也不加入别人的共享查询；
 * - 缓存只放在模块级 Map 里，不共享、不写入 Session checkpoint/task 字段；
 * - 提交/基线等写操作由调用方（`integration.ts` 写函数、`routes-git.ts` 写路由）调用
 *   `invalidateGitReadCache()` 失效；决策链路（`integration.ts` 的异步函数、`git-workspace.ts` 的检查目标）
 *   始终走下面的 `fetch*` 直读，不受缓存影响，不改变 Git 写语义。
 */

export const GIT_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
export const GIT_INSPECT_CACHE_TTL_MS = 2_000;
export const GIT_IDENTITY_CACHE_TTL_MS = 10_000;
export const GIT_STATUS_PREVIEW_CACHE_TTL_MS = 1_000;
export const GIT_HEAD_CACHE_TTL_MS = 2_000;
export const GIT_DIRS_CACHE_TTL_MS = 60_000;

/** 状态预览保留的行数上限（`integration.ts` 与这里共用同一口径）。 */
export const GIT_STATUS_PREVIEW_LIMIT = 100;

export interface GitReadCacheOptions {
	/** 为 true 时绕过缓存强制读取最新状态（关键写操作/用户显式刷新前使用）。 */
	fresh?: boolean;
	signal?: AbortSignal;
}

export interface GitVersionInfo {
	available: boolean;
	version?: string;
	error?: string;
}

export interface GitHeadInfo {
	sha: string;
	subject: string;
}

interface Scope<T> {
	cache: Map<string, { expiresAt: number; value: T; version: number }>;
	inflight: Map<string, { promise: Promise<T>; version: number; fresh: boolean }>;
	versions: Map<string, number>;
}

function createScope<T>(): Scope<T> {
	return { cache: new Map(), inflight: new Map(), versions: new Map() };
}

const versionScope = createScope<GitVersionInfo>();
const inspectScope = createScope<GitRepositoryState>();
const identityScope = createScope<GitIdentity>();
const previewScope = createScope<GitStatusPreview | undefined>();
const headScope = createScope<GitHeadInfo | null>();
const dirsScope = createScope<boolean>();
const branchesScope = createScope<GitBranchListResult>();

/** 与 `status-cache.ts` 同一键归一化：绝对路径，Windows 下不区分大小写。 */
function normalizeTarget(target: string): string {
	const resolved = resolve(target);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 仅供测试观察的底层 Git 调用计数（缓存命中与在途合并不会增加它）。 */
let underlyingCalls = 0;

/** 测试读取底层调用计数；生产代码不依赖它。 */
export function getGitReadCacheUnderlyingCallCount(): number {
	return underlyingCalls;
}

/** 测试重置底层调用计数与缓存内容；生产代码不调用它。 */
export function resetGitReadCacheForTests(): void {
	for (const scope of [versionScope, inspectScope, identityScope, previewScope, headScope, dirsScope, branchesScope]) {
		scope.cache.clear();
		scope.inflight.clear();
		scope.versions.clear();
	}
	underlyingCalls = 0;
}

async function spawnRead(args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<GitCommandResult> {
	underlyingCalls++;
	return runGit(args, {
		cwd: options.cwd,
		env: { GIT_OPTIONAL_LOCKS: "0" },
		signal: options.signal,
	});
}

/** 传输类失败（进程起不来、超时、被取消）不代表 Git 的回答，不能缓存。 */
function isTransportFailure(result: GitCommandResult): boolean {
	return !result.ok && result.failureKind !== "exit";
}

function nextVersion<T>(scope: Scope<T>, key: string): number {
	const version = (scope.versions.get(key) ?? 0) + 1;
	scope.versions.set(key, version);
	return version;
}

function loadScope<T>(scope: Scope<T>, key: string): { hit: true; value: T } | { hit: false } {
	const entry = scope.cache.get(key);
	if (!entry) return { hit: false };
	if (entry.expiresAt <= Date.now()) {
		scope.cache.delete(key);
		return { hit: false };
	}
	if ((scope.versions.get(key) ?? 0) !== entry.version) {
		scope.cache.delete(key);
		return { hit: false };
	}
	return { hit: true, value: entry.value };
}

function storeIfCurrent<T>(scope: Scope<T>, key: string, value: T, version: number, ttlMs: number): void {
	if ((scope.versions.get(key) ?? 0) !== version) return;
	scope.cache.set(key, { expiresAt: Date.now() + ttlMs, value, version });
	while (scope.cache.size > 128) scope.cache.delete(scope.cache.keys().next().value!);
}

async function readThrough<T>(
	scope: Scope<T>,
	key: string,
	ttlMs: number,
	options: GitReadCacheOptions,
	fetch: (signal?: AbortSignal) => Promise<{ value: T; cacheable: boolean }>,
): Promise<T> {
	if (options.signal) {
		// 调用方自己的取消不能取消别人的共享读取：走隔离直读。
		return (await fetch(options.signal)).value;
	}
	if (!options.fresh) {
		const cached = loadScope(scope, key);
		if (cached.hit) return cached.value;
	}
	const ongoing = scope.inflight.get(key);
	if (ongoing && (!options.fresh || ongoing.fresh)) return ongoing.promise;
	const version = nextVersion(scope, key);
	const promise = (async (): Promise<T> => {
		try {
			const { value, cacheable } = await fetch(undefined);
			if (cacheable) storeIfCurrent(scope, key, value, version, ttlMs);
			return value;
		} finally {
			if (scope.inflight.get(key)?.version === version) scope.inflight.delete(key);
		}
	})();
	scope.inflight.set(key, { promise, version, fresh: !!options.fresh });
	return promise;
}

async function fetchVersionInternal(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ value: GitVersionInfo; cacheable: boolean }> {
	const result = await spawnRead(["--version"], { cwd, signal });
	if (!result.ok) {
		return {
			value: { available: false, error: result.error || result.stderr.trim() || "找不到 Git 命令" },
			cacheable: false,
		};
	}
	return { value: { available: true, version: result.stdout.trim() }, cacheable: true };
}

async function fetchInspectInternal(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ value: GitRepositoryState; cacheable: boolean }> {
	// 版本检测进程复用：环境信息全局共享，不随 checkout 区分，也不被调用方取消。
	const version = await getCachedGitVersion(cwd);
	if (!version.available) {
		return {
			value: {
				gitAvailable: false,
				isRepository: false,
				hasBaseline: false,
				error: version.error ?? "找不到 Git 命令",
			},
			cacheable: false,
		};
	}
	const rootResult = await spawnRead(["rev-parse", "--show-toplevel"], { cwd, signal });
	const rootOutput = rootResult.stdout.trim();
	if (!rootResult.ok || !rootOutput) {
		// exit 失败是 Git 的有效回答（非仓库），按短 TTL 缓存；传输失败不缓存。
		return {
			value: { gitAvailable: true, isRepository: false, hasBaseline: false },
			cacheable: !isTransportFailure(rootResult),
		};
	}
	const root = resolveGitRepositoryRoot(cwd, rootOutput);
	const [baselineResult, branchResult] = await Promise.all([
		spawnRead(["rev-parse", "--verify", "HEAD"], { cwd: root, signal }),
		spawnRead(["branch", "--show-current"], { cwd: root, signal }),
	]);
	return {
		value: {
			gitAvailable: true,
			isRepository: true,
			root,
			hasBaseline: baselineResult.ok,
			branch: branchResult.stdout.trim() || undefined,
		},
		cacheable: !isTransportFailure(baselineResult) && !isTransportFailure(branchResult),
	};
}

async function readConfigValue(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ value: string | undefined; transport: boolean }> {
	const result = await spawnRead(args, { cwd, signal });
	if (!result.ok && isTransportFailure(result)) return { value: undefined, transport: true };
	// `config --get` 在未设置时以 exit 失败返回空输出：这是有效的“未设置”，不是失败。
	const text = result.stdout.trim();
	return { value: result.ok && text ? text : undefined, transport: false };
}

async function fetchIdentityInternal(
	cwd: string,
	repositoryRoot: string | undefined,
	signal?: AbortSignal,
): Promise<{ value: GitIdentity; cacheable: boolean }> {
	const [localName, localEmail, globalName, globalEmail] = await Promise.all([
		repositoryRoot
			? readConfigValue(repositoryRoot, ["config", "--local", "--get", "user.name"], signal)
			: { value: undefined, transport: false },
		repositoryRoot
			? readConfigValue(repositoryRoot, ["config", "--local", "--get", "user.email"], signal)
			: { value: undefined, transport: false },
		readConfigValue(cwd, ["config", "--global", "--get", "user.name"], signal),
		readConfigValue(cwd, ["config", "--global", "--get", "user.email"], signal),
	]);
	return {
		value: {
			name: localName.value ?? globalName.value,
			email: localEmail.value ?? globalEmail.value,
		},
		cacheable: !localName.transport && !localEmail.transport && !globalName.transport && !globalEmail.transport,
	};
}

async function fetchPreviewInternal(
	repositoryRoot: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<{ value: GitStatusPreview | undefined; cacheable: boolean }> {
	const args = ["status", "--short", "--untracked-files=all"];
	if (paths.length > 0) args.push("--", ...paths);
	const result = await spawnRead(args, { cwd: repositoryRoot, signal });
	if (!result.ok) return { value: undefined, cacheable: false };
	const output = result.stdout.replace(/\s+$/u, "");
	const allLines = output ? output.split(/\r?\n/).filter(Boolean) : [];
	return {
		value: {
			lines: allLines.slice(0, GIT_STATUS_PREVIEW_LIMIT),
			total: allLines.length,
			truncated: allLines.length > GIT_STATUS_PREVIEW_LIMIT,
		},
		cacheable: true,
	};
}

async function fetchHeadInternal(
	repositoryRoot: string,
	signal?: AbortSignal,
): Promise<{ value: GitHeadInfo | null; cacheable: boolean }> {
	const result = await spawnRead(["log", "-1", "--format=%H%n%s"], { cwd: repositoryRoot, signal });
	if (!result.ok) return { value: null, cacheable: false };
	const [sha, ...subject] = result.stdout.trim().split("\n");
	if (!sha) return { value: null, cacheable: false };
	return { value: { sha, subject: subject.join("\n") }, cacheable: true };
}

async function fetchDirsInternal(
	repositoryRoot: string,
	signal?: AbortSignal,
): Promise<{ value: boolean; cacheable: boolean }> {
	const result = await spawnRead(["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
		cwd: repositoryRoot,
		signal,
	});
	if (!result.ok) return { value: false, cacheable: false };
	const [gitDir, commonDir] = result.stdout.trim().split(/\r?\n/u);
	if (!gitDir || !commonDir) return { value: false, cacheable: false };
	// 关联 Worktree 的 git 目录位于主仓库公共目录之下（与 routes-git.ts 原逻辑一致）。
	// Compare real paths: on Windows git prints the long name while the caller's path may use a short (8.3) name.
	const [realGitDir, realCommonDir] = await Promise.all([
		realpath(gitDir).catch(() => resolve(gitDir)),
		realpath(resolve(repositoryRoot, commonDir)).catch(() => resolve(repositoryRoot, commonDir)),
	]);
	return { value: realGitDir !== realCommonDir, cacheable: true };
}

/** 直读仓库状态：与 `integration.ts` 的异步检查语义相同，不接触缓存，供决策链路使用。 */
export async function fetchGitRepositoryState(cwd: string, signal?: AbortSignal): Promise<GitRepositoryState> {
	return (await fetchInspectInternal(cwd, signal)).value;
}

/** 直读 Git 身份：语义同 `integration.ts`，不接触缓存。 */
export async function fetchGitIdentity(
	cwd: string,
	repositoryRoot?: string,
	signal?: AbortSignal,
): Promise<GitIdentity> {
	return (await fetchIdentityInternal(cwd, repositoryRoot, signal)).value;
}

/** 直读状态预览：语义同 `integration.ts`，不接触缓存。 */
export async function fetchGitStatusPreview(
	repositoryRoot: string,
	paths: string[] = [],
	signal?: AbortSignal,
): Promise<GitStatusPreview | undefined> {
	return (await fetchPreviewInternal(repositoryRoot, paths, signal)).value;
}

/** 版本检测进程复用：全局单 key，调用方取消不影响共享读取。 */
export function getCachedGitVersion(cwd: string, options: GitReadCacheOptions = {}): Promise<GitVersionInfo> {
	return readThrough(versionScope, "version\0global", GIT_VERSION_CACHE_TTL_MS, options, (signal) =>
		fetchVersionInternal(cwd, signal),
	);
}

/** 短 TTL（2 秒）仓库检查：同 checkout 并发合并，不同 Worktree 按路径隔离。 */
export function getCachedGitInspect(cwd: string, options: GitReadCacheOptions = {}): Promise<GitRepositoryState> {
	return readThrough(inspectScope, `inspect\0${normalizeTarget(cwd)}`, GIT_INSPECT_CACHE_TTL_MS, options, (signal) =>
		fetchInspectInternal(cwd, signal),
	);
}

/** 短 TTL（10 秒）Git 身份：本地配置优先，与异步直读语义一致。 */
export function getCachedGitIdentity(
	cwd: string,
	repositoryRoot: string | undefined,
	options: GitReadCacheOptions = {},
): Promise<GitIdentity> {
	const rootSegment = repositoryRoot === undefined ? "-" : normalizeTarget(repositoryRoot);
	return readThrough(
		identityScope,
		`identity\0${normalizeTarget(cwd)}\0${rootSegment}`,
		GIT_IDENTITY_CACHE_TTL_MS,
		options,
		(signal) => fetchIdentityInternal(cwd, repositoryRoot, signal),
	);
}

/** 短 TTL（1 秒）状态预览：失败不缓存，供高频轮询使用，提交决策仍走同步直读。 */
export function getCachedGitStatusPreview(
	repositoryRoot: string,
	paths: string[] = [],
	options: GitReadCacheOptions = {},
): Promise<GitStatusPreview | undefined> {
	return readThrough(
		previewScope,
		`preview\0${normalizeTarget(repositoryRoot)}\0${paths.join("\0")}`,
		GIT_STATUS_PREVIEW_CACHE_TTL_MS,
		options,
		(signal) => fetchPreviewInternal(repositoryRoot, paths, signal),
	);
}

/** 短 TTL（2 秒）HEAD：失败返回 null 且不缓存。 */
export function getCachedGitHead(
	repositoryRoot: string,
	options: GitReadCacheOptions = {},
): Promise<GitHeadInfo | null> {
	return readThrough(headScope, `head\0${normalizeTarget(repositoryRoot)}`, GIT_HEAD_CACHE_TTL_MS, options, (signal) =>
		fetchHeadInternal(repositoryRoot, signal),
	);
}

/** 短 TTL（60 秒）Git 目录布局：目录结构几乎不变，只做在途合并与长缓存。 */
export function getCachedGitLinkedWorktree(
	repositoryRoot: string,
	options: GitReadCacheOptions = {},
): Promise<boolean> {
	return readThrough(dirsScope, `dirs\0${normalizeTarget(repositoryRoot)}`, GIT_DIRS_CACHE_TTL_MS, options, (signal) =>
		fetchDirsInternal(repositoryRoot, signal),
	);
}

/** UI-only branch snapshot; mutations and safety decisions still read Git directly. */
export function getCachedGitBranches(
	repositoryRoot: string,
	options: GitReadCacheOptions = {},
): Promise<GitBranchListResult> {
	return readThrough(branchesScope, `branches\0${normalizeTarget(repositoryRoot)}`, 2_000, options, async () => {
		underlyingCalls++;
		const value = await listLocalBranchesAsync(repositoryRoot);
		return { value, cacheable: value.ok };
	});
}

function keyTargets(key: string, normalized: string): boolean {
	return key.split("\0").slice(1).includes(normalized);
}

function dropKeysFor<T>(scope: Scope<T>, predicate: (key: string) => boolean): void {
	for (const key of [...scope.cache.keys()]) {
		if (!predicate(key)) continue;
		scope.cache.delete(key);
		scope.versions.set(key, (scope.versions.get(key) ?? 0) + 1);
		scope.inflight.delete(key);
	}
	for (const key of [...scope.inflight.keys()]) {
		if (!predicate(key)) continue;
		scope.versions.set(key, (scope.versions.get(key) ?? 0) + 1);
		scope.inflight.delete(key);
	}
}

/**
 * 写操作完成后失效对应 checkout（或全部）的读缓存。
 * 传 `cwd` 或 `root` 均可：按 key 匹配，inspect 缓存还会按解析出的 `root` 扫描，
 * 覆盖 `cwd` 与 `root` 拼写不一致的情况。只删内存快照，永不失败。
 */
export function invalidateGitReadCache(target?: string): void {
	if (target === undefined) {
		for (const scope of [
			versionScope,
			inspectScope,
			identityScope,
			previewScope,
			headScope,
			dirsScope,
			branchesScope,
		]) {
			for (const key of new Set([...scope.cache.keys(), ...scope.inflight.keys(), ...scope.versions.keys()])) {
				scope.versions.set(key, (scope.versions.get(key) ?? 0) + 1);
			}
			scope.cache.clear();
			scope.inflight.clear();
		}
		return;
	}
	const normalized = normalizeTarget(target);
	const roots = new Set([normalized]);
	for (const [key, entry] of inspectScope.cache) {
		if (keyTargets(key, normalized) && entry.value.root) roots.add(normalizeTarget(entry.value.root));
	}
	const matches = (key: string): boolean => [...roots].some((root) => keyTargets(key, root));
	dropKeysFor(identityScope, matches);
	dropKeysFor(previewScope, matches);
	dropKeysFor(headScope, matches);
	dropKeysFor(dirsScope, matches);
	// Branch occupancy is shared by every checkout, so invalidate all branch snapshots on a write.
	dropKeysFor(branchesScope, () => true);
	dropKeysFor(inspectScope, (key) => {
		if (matches(key)) return true;
		// An unfinished inspect may not have resolved its root yet. Drop it conservatively rather than accept a pre-write branch.
		if (inspectScope.inflight.has(key)) return true;
		const entry = inspectScope.cache.get(key);
		return entry !== undefined && entry.value.root !== undefined && normalizeTarget(entry.value.root) === normalized;
	});
}
