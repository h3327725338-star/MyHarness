import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	collectGitCheckpointHeadChanges,
	collectGitCheckpointLocalRefChanges,
	collectGitCheckpointWorkingTreeChanges,
	type GitCheckpoint,
	getGitCheckpointPendingTaskPaths,
	observeGitCheckpointFinalState,
} from "../checkpoints/checkpoint.ts";
import { runGitSync } from "./command.ts";
import type { AutoReviewMutation, ReviewChange, ReviewChangeStatus } from "./review-types.ts";

// ============================================================================
// ChangeSet：真实工作区变化集合
//
// 事实来源优先级：
//   1. Git checkpoint（Git 集成开启时）：保存的基线树与当前 Git 状态直接比较。
//   2. 无 checkpoint 时（Git 集成关闭）：工作区内容基线对比（bash fallback）
//      与 edit/write 工具前后快照（beforeHash/afterHash）对比。
// ============================================================================

export const DEFAULT_WORKSPACE_BASELINE_MAX_FILES = 100_000;
export const DEFAULT_WORKSPACE_BASELINE_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * 小文件（≤512KB）在基线建立时读取内容做 sha256，检测阶段能区分“内容未变的
 * touch”与真实修改；大文件只记录 stat 指纹（size:mtime），不读内容，保证
 * 大仓库扫描成本可控。stat 指纹变化的大文件保守按 modified 报告。
 * maxBytes 约束的是小文件内容读取总量（基线建立的一次性成本）。
 */
const BASELINE_CONTENT_HASH_MAX_BYTES = 512 * 1024;

const BASELINE_EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".output",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"coverage",
	".turbo",
	".nx",
	".idea",
	".vscode",
]);

const BASELINE_EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);

export interface WorkspaceBaselineOptions {
	maxFiles?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}

export interface WorkspaceBaselineEntry {
	/** 小文件：内容 sha256；大文件：空串（仅 stat 指纹可用）。 */
	hash: string;
	size: number;
	/** size:mtime:ctime 指纹；一致即视为未变化，跳过内容读取。 */
	statKey: string;
}

export interface WorkspaceBaseline {
	/** key：相对 cwd 的正斜杠路径。 */
	files: Map<string, WorkspaceBaselineEntry>;
	/** 内容读取预算耗尽等导致部分小文件缺内容 hash 时为 true；基线仍可用于检测，但 touch 识别不完整，调用方需在提示中如实说明。 */
	truncated: boolean;
}

function createWorkspaceScanAbortError(): Error {
	const error = new Error("工作区变化检测已取消。");
	error.name = "AbortError";
	return error;
}

function toCwdRelativePath(cwd: string, absolutePath: string): string | undefined {
	const root = path.resolve(cwd);
	const absolute = path.resolve(absolutePath);
	const relative = path.relative(root, absolute);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	return relative.split(path.sep).join("/");
}

function isExcludedBaselineDirectory(name: string): boolean {
	return BASELINE_EXCLUDED_DIRECTORIES.has(name);
}

function isExcludedBaselineFile(name: string): boolean {
	return BASELINE_EXCLUDED_FILES.has(name);
}

/** Windows 文件系统大小写不敏感：仅 Windows 平台归一化为小写比较。 */
function pathCompareKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * 对任务工作目录做一次基线快照。扫描使用 stat 指纹（size:mtime:ctime），仅对小文件
 * （≤512KB，且内容读取总量 ≤ maxBytes）额外计算内容 sha256；不跟随符号链接，
 * 排除常见重目录（node_modules、dist、.git 等）。文件数超过 maxFiles 或内容
 * 读取预算耗尽时标记 truncated：基线仍可用于检测（含 added/deleted/modified），
 * 但 touch 识别对未做内容 hash 的文件不可用，调用方需如实提示。
 */
export async function captureWorkspaceBaseline(
	cwd: string,
	options: WorkspaceBaselineOptions = {},
): Promise<WorkspaceBaseline> {
	const root = path.resolve(cwd);
	const maxFiles = options.maxFiles ?? DEFAULT_WORKSPACE_BASELINE_MAX_FILES;
	const maxBytes = options.maxBytes ?? DEFAULT_WORKSPACE_BASELINE_MAX_BYTES;
	const files = new Map<string, WorkspaceBaselineEntry>();
	let hashedBytes = 0;
	let truncated = false;

	type BaselineJob = { absolutePath: string; relativePath: string };
	const jobs: BaselineJob[] = [];

	const walk = async (directory: string): Promise<void> => {
		if (options.signal?.aborted) throw createWorkspaceScanAbortError();
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (options.signal?.aborted) throw createWorkspaceScanAbortError();
			const absolutePath = path.join(directory, entry.name);
			const relativePath = toCwdRelativePath(root, absolutePath);
			if (!relativePath) continue;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (isExcludedBaselineDirectory(entry.name)) continue;
				await walk(absolutePath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isExcludedBaselineFile(entry.name)) continue;
			jobs.push({ absolutePath, relativePath });
		}
	};

	await walk(root);
	if (jobs.length > maxFiles) {
		jobs.length = maxFiles;
		truncated = true;
	}

	// 固定并发处理文件队列：数万文件的 stat+hash 并发完成（顺序逐文件
	// await 会使大仓库基线建立耗时数分钟）。预算按实际读取量记账，
	// 超预算的小文件标记截断但仍记录 stat 指纹。
	const processJob = async (job: BaselineJob): Promise<void> => {
		if (options.signal?.aborted) throw createWorkspaceScanAbortError();
		let stat: fs.BigIntStats;
		try {
			stat = await fs.promises.stat(job.absolutePath, { bigint: true });
		} catch {
			return;
		}
		const size = Number(stat.size);
		const statKey = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
		let hash = "";
		if (size <= BASELINE_CONTENT_HASH_MAX_BYTES) {
			if (hashedBytes + size > maxBytes) {
				truncated = true;
			} else {
				let content: Buffer;
				try {
					content = await fs.promises.readFile(job.absolutePath);
				} catch {
					return;
				}
				hashedBytes += content.length;
				hash = createHash("sha256").update(content).digest("hex");
			}
		}
		files.set(job.relativePath, { hash, size, statKey });
	};
	const workers = Array.from({ length: 24 }, async () => {
		for (;;) {
			const job = jobs.shift();
			if (!job) return;
			await processJob(job);
		}
	});
	await Promise.all(workers);
	return { files, truncated };
}

/**
 * 对比当前工作区与基线，返回真实变化。stat 指纹一致的文件直接视为未变化；
 * stat 变化的小文件用内容 hash 复核（touch 不误报），基线期未做内容 hash 的
 * 大文件保守按 modified 报告。
 */
export async function detectWorkspaceChangesFromBaseline(
	cwd: string,
	baseline: WorkspaceBaseline,
	options: WorkspaceBaselineOptions = {},
): Promise<ReviewChange[]> {
	const root = path.resolve(cwd);
	const changes: ReviewChange[] = [];
	const seenCurrent = new Set<string>();

	const walk = async (directory: string): Promise<void> => {
		if (options.signal?.aborted) throw createWorkspaceScanAbortError();
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (options.signal?.aborted) throw createWorkspaceScanAbortError();
			const absolutePath = path.join(directory, entry.name);
			const relativePath = toCwdRelativePath(root, absolutePath);
			if (!relativePath) continue;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (isExcludedBaselineDirectory(entry.name)) continue;
				await walk(absolutePath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isExcludedBaselineFile(entry.name)) continue;
			seenCurrent.add(relativePath);
			const baselineEntry = baseline.files.get(relativePath);
			if (!baselineEntry) {
				changes.push({ path: relativePath, status: "added" });
				continue;
			}
			// 小文件必须做内容级对比：Windows NTFS 会合并快速连续写入的
			// mtime（实测同进程两次写入 mtimeNs 完全相同），mtime 快捷路径
			// 会漏检。statKey 只用于基线期未读内容的大文件快速路径。
			if (baselineEntry.hash) {
				let content: Buffer;
				try {
					content = await fs.promises.readFile(absolutePath);
				} catch {
					continue;
				}
				const hash = createHash("sha256").update(content).digest("hex");
				if (hash !== baselineEntry.hash) changes.push({ path: relativePath, status: "modified" });
				continue;
			}
			let stat: fs.BigIntStats;
			try {
				stat = await fs.promises.stat(absolutePath, { bigint: true });
			} catch {
				continue;
			}
			const statKey = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			if (statKey !== baselineEntry.statKey) {
				// 基线期未读内容的大文件：stat 变化即保守报告 modified。
				changes.push({ path: relativePath, status: "modified" });
			}
		}
	};

	await walk(root);

	for (const relativePath of baseline.files.keys()) {
		if (seenCurrent.has(relativePath)) continue;
		if (!existsSync(path.join(root, relativePath))) {
			changes.push({ path: relativePath, status: "deleted" });
		}
	}
	return changes;
}

// ============================================================================
// Git checkpoint 变化提取
// ============================================================================

/**
 * 从 Git checkpoint 提取真实工作区变化，直接比较任务开始时的基线树和当前状态。
 *
 * 重命名检测：Git 不修改 index 时无法自动报告工作区 rename（untracked 新文件
 * 不参与 git 的 rename 检测），因此这里用 blob oid 配对：被删除文件的基线
 * blob 与新增文件的当前内容一致时，判定为 renamed。
 */
export async function collectCheckpointChanges(options: {
	cwd: string;
	checkpoint: GitCheckpoint;
}): Promise<ReviewChange[]> {
	const result = collectGitCheckpointWorkingTreeChanges(options.checkpoint);
	if (!result.changes) return [];
	const byPath = new Map(result.changes.map((change) => [change.path, change]));

	// rename 配对：added 的当前 blob oid 与 deleted 的基线 blob oid 一致。
	// renamed 只出现在 ReviewChange 层（GitCheckpointHeadChange 不含 renamed）。
	const renamedOldPaths = new Map<string, string>();
	const added = result.changes.filter((change) => change.status === "added");
	const deleted = result.changes.filter((change) => change.status === "deleted");
	if (added.length > 0 && deleted.length > 0 && options.checkpoint.worktreeTree) {
		const currentOids = new Map<string, string | undefined>();
		for (const change of added) {
			const hash = runGitSync(["hash-object", path.resolve(options.checkpoint.repositoryRoot, change.path)], {
				cwd: options.checkpoint.repositoryRoot,
			});
			if (hash.ok && hash.stdout) currentOids.set(change.path, hash.stdout);
		}
		const baselineOids = new Map<string, string | undefined>();
		for (const change of deleted) {
			const rev = runGitSync(["rev-parse", "--verify", `${options.checkpoint.worktreeTree}:${change.path}`], {
				cwd: options.checkpoint.repositoryRoot,
			});
			if (rev.ok && rev.stdout) baselineOids.set(change.path, rev.stdout);
		}
		for (const change of added) {
			const currentOid = currentOids.get(change.path);
			if (!currentOid) continue;
			const match = deleted.find((deletedChange) => baselineOids.get(deletedChange.path) === currentOid);
			if (!match) continue;
			byPath.delete(match.path);
			renamedOldPaths.set(change.path, match.path);
		}
	}

	const changes: ReviewChange[] = [];
	for (const change of byPath.values()) {
		const cwdPath = toCwdRelativePath(options.cwd, path.join(options.checkpoint.repositoryRoot, change.path));
		if (!cwdPath) continue;
		const oldRepoPath = renamedOldPaths.get(change.path);
		if (!oldRepoPath) {
			changes.push({ path: cwdPath, status: change.status });
			continue;
		}
		const oldPath = toCwdRelativePath(options.cwd, path.join(options.checkpoint.repositoryRoot, oldRepoPath));
		changes.push({ path: cwdPath, status: "renamed", ...(oldPath ? { oldPath } : {}) });
	}
	return changes;
}

// ============================================================================
// edit/write 快照对比
// ============================================================================

/**
 * 把 edit/write 工具记录（含 beforeHash/afterHash）转成真实变化。
 * 内容没有变化（前后 hash 相同）的记录被排除，不作为 Auto Review 的启动依据。
 * 已带 status 的记录（bash 检测结果）原样保留。
 */
export function toReviewChanges(cwd: string, mutations: readonly AutoReviewMutation[]): ReviewChange[] {
	const root = path.resolve(cwd);
	const changes: ReviewChange[] = [];
	const seen = new Set<string>();
	for (const mutation of mutations) {
		const relativePath = toCwdRelativePath(root, path.resolve(root, mutation.path));
		if (!relativePath || seen.has(pathCompareKey(relativePath))) continue;

		if (mutation.status) {
			seen.add(pathCompareKey(relativePath));
			changes.push({
				path: relativePath,
				status: mutation.status,
				...(mutation.oldPath ? { oldPath: mutation.oldPath } : {}),
			});
			continue;
		}

		const beforeHash = mutation.beforeHash;
		const afterHash = mutation.afterHash;
		// 工具调用成功但文件内容没有变化：不是真实修改。
		if (beforeHash !== undefined && afterHash !== undefined && beforeHash === afterHash) continue;

		let existsNow: boolean;
		try {
			existsNow = existsSync(path.resolve(root, relativePath));
		} catch {
			existsNow = false;
		}

		let status: ReviewChangeStatus;
		if (beforeHash === undefined && afterHash === undefined && !existsNow) {
			continue; // 前后都不存在，没有任何变化证据。
		}
		if (beforeHash === undefined && afterHash !== undefined) {
			status = "added";
		} else if (afterHash === undefined && !existsNow && beforeHash !== undefined) {
			status = "deleted";
		} else {
			status = "modified";
		}
		seen.add(pathCompareKey(relativePath));
		changes.push({ path: relativePath, status });
	}
	return changes;
}

// ============================================================================
// Final ChangeSet：任务结束时统一计算的最终真实变化
// ============================================================================

/**
 * 最终变化检测结果。
 * - known：检测可靠，changes 是任务开始时与任务结束时的完整差异。
 * - indeterminate：检测不可靠（如工作区基线被截断），changes 只包含已知部分，
 *   调用方必须进入保守路径，不得把“无法判断”当作“没有变化”。
 */
export type ChangeDetectionResult =
	| { status: "known"; changes: ReviewChange[]; git?: GitTaskChangeSummary }
	| { status: "indeterminate"; changes: ReviewChange[]; reason: string; git?: GitTaskChangeSummary };

export interface GitTaskChangeSummary {
	hasTaskChanges: boolean;
	contentChanges: boolean;
	indexChanged: boolean;
	headChanged: boolean;
	headRefChanged: boolean;
	localRefChanges: Array<{ ref: string; kind: "created" | "deleted" | "moved"; before?: string; after?: string }>;
	pendingPaths: string[];
	gitSave: "pending" | "satisfied";
	remoteSideEffects: boolean;
	/** Opaque execution occurred, so remote/external side effects cannot be proven absent. */
	externalSideEffectsUnknown: boolean;
	historyOnly: boolean;
	historyNavigation: boolean;
	taskCreatedHistory: boolean;
}

function mergeReviewChanges(primary: readonly ReviewChange[], secondary: readonly ReviewChange[]): ReviewChange[] {
	const result = primary.map((change) => ({ ...change }));
	const seen = new Set(result.map((change) => pathCompareKey(change.path)));
	for (const change of secondary) {
		if (seen.has(pathCompareKey(change.path))) continue;
		seen.add(pathCompareKey(change.path));
		result.push({ ...change });
	}
	return result;
}

export interface CollectFinalWorkspaceChangesOptions {
	cwd: string;
	/** Git 集成开启时的任务级 checkpoint；仅在 status 为 created 时作为事实来源。 */
	checkpoint?: GitCheckpoint;
	/** 非 Git 任务级内容基线（任务开始时建立）。 */
	baseline?: WorkspaceBaseline;
	/** 基线建立失败或被截断的原因；存在且无可用基线时整体检测不可靠。 */
	baselineFailureReason?: string;
	/** 工具调用审计记录；仅在检测不可靠时用于保留已知的 edit/write 变化。 */
	auditMutations?: readonly AutoReviewMutation[];
}

/**
 * 统一计算任务级 Final ChangeSet：任务开始时基线 vs 当前最终工作区状态。
 * 事实来源优先级：Git checkpoint（created）> 工作区内容基线 > （不可靠时）edit/write 快照。
 */
export async function collectFinalWorkspaceChanges(
	options: CollectFinalWorkspaceChangesOptions,
): Promise<ChangeDetectionResult> {
	const { cwd, checkpoint, baseline, baselineFailureReason, auditMutations } = options;
	if (checkpoint && checkpoint.status === "created") {
		const workingChanges = await collectCheckpointChanges({ cwd, checkpoint });
		const current = await observeGitCheckpointFinalState(checkpoint);
		if (!current.observation) {
			return {
				status: "indeterminate",
				changes: workingChanges,
				reason:
					current.error ??
					"Final ChangeSet 计算前检测到工具窗口外的 Git index/HEAD/ref 漂移，拒绝归属为当前任务。",
			};
		}

		const head = collectGitCheckpointHeadChanges(checkpoint);
		if (!head.changes) {
			return {
				status: "indeterminate",
				changes: workingChanges,
				reason: head.error ?? "无法形成可靠的 committed Final ChangeSet。",
			};
		}
		const committedChanges: ReviewChange[] = [];
		for (const change of head.changes) {
			const cwdPath = toCwdRelativePath(cwd, path.join(checkpoint.repositoryRoot, change.path));
			if (cwdPath) committedChanges.push({ path: cwdPath, status: change.status });
		}
		const changes = mergeReviewChanges(workingChanges, committedChanges);
		const pending = getGitCheckpointPendingTaskPaths(checkpoint);
		if (!pending.paths) {
			return {
				status: "indeterminate",
				changes,
				reason: pending.error ?? "无法判断剩余未提交任务路径。",
			};
		}
		const contentChanges = changes.length > 0;
		// checkpoint 保存的是任务开始时的 write-tree oid；当前 index 同样用
		// write-tree 取内容指纹比较（比旧的 staged diff patch hash 更精确、零临时文件）。
		const currentIndexTree = runGitSync(["write-tree"], { cwd: checkpoint.repositoryRoot });
		if (!currentIndexTree.ok || !currentIndexTree.stdout) {
			return {
				status: "indeterminate",
				changes,
				reason: currentIndexTree.error ?? "无法读取当前 Git 暂存区状态。",
			};
		}
		const indexChanged = checkpoint.indexTree !== currentIndexTree.stdout;
		const headChanged = checkpoint.headCommit !== current.observation.headCommit;
		const headRefChanged = checkpoint.headRef !== current.observation.headRef;
		const localRefChanges = collectGitCheckpointLocalRefChanges(checkpoint);
		const remoteSideEffects = false;
		// 与 restore 后的提示保持一致：任务执行过不透明 Bash 时，Final ChangeSet
		// 也如实报告外部/远端副作用未知，而不是硬编码为“没有”。
		const externalSideEffectsUnknown = checkpoint.hadBashExecution === true;
		const hasTaskChanges =
			contentChanges ||
			indexChanged ||
			headChanged ||
			headRefChanged ||
			localRefChanges.length > 0 ||
			remoteSideEffects;
		return {
			status: "known",
			changes,
			...(indexChanged ||
			headChanged ||
			headRefChanged ||
			localRefChanges.length > 0 ||
			remoteSideEffects ||
			externalSideEffectsUnknown
				? {
						git: {
							hasTaskChanges,
							contentChanges,
							indexChanged,
							headChanged,
							headRefChanged,
							localRefChanges,
							pendingPaths: pending.paths,
							gitSave: pending.paths.length > 0 ? ("pending" as const) : ("satisfied" as const),
							remoteSideEffects,
							externalSideEffectsUnknown,
							historyOnly:
								(headChanged || headRefChanged) &&
								!contentChanges &&
								!indexChanged &&
								localRefChanges.length === 0 &&
								!remoteSideEffects &&
								!externalSideEffectsUnknown,
							historyNavigation: false,
							taskCreatedHistory: headChanged,
						},
					}
				: {}),
		};
	}
	if (baseline) {
		const changes = await detectWorkspaceChangesFromBaseline(cwd, baseline);
		return { status: "known", changes };
	}
	if (baselineFailureReason) {
		// 检测不可靠：保留已知的 edit/write 变化，但整体必须进入保守路径。
		const knownChanges = toReviewChanges(cwd, auditMutations ?? []);
		return { status: "indeterminate", changes: knownChanges, reason: baselineFailureReason };
	}
	// 没有需要检测的工具调用（无 checkpoint、无基线、无失败原因）：确实没有变化。
	return { status: "known", changes: [] };
}

// ============================================================================
// Review State Fingerprint：Repair 前后工作区状态指纹
//
// Final ChangeSet 只有 path/status/oldPath，不包含文件内容。Repair 把
// a.ts 从“BUG 版本”改成“修复版本”时，前后 ChangeSet 完全相同
// （[{ path: "a.ts", status: "modified" }]），无法区分是否真的产生了
// 代码变化。指纹对 ChangeSet 涉及的路径计算内容 hash，能区分内容 A 与
// 内容 B，并覆盖 added / deleted / renamed / binary。
// ============================================================================

export interface ReviewStateFingerprintEntry {
	/** 正斜杠相对路径（与 ReviewChange.path 一致）。 */
	path: string;
	status: ReviewChangeStatus;
	/** modified/added/renamed 目标路径的文件内容 sha256；文件不存在时为 "<missing>"。 */
	contentHash?: string;
	/** status 为 renamed 时的原路径。 */
	oldPath?: string;
}

export interface ReviewStateFingerprint {
	/** 全部条目（按 path 排序）序列化后的 sha256；相同状态+相同内容 ⇒ 相同 hash。 */
	hash: string;
	entries: ReviewStateFingerprintEntry[];
}

const MISSING_CONTENT_HASH = "<missing>";

function fingerprintEntryKey(entry: ReviewStateFingerprintEntry): string {
	return `${entry.path}\u0000${entry.status}\u0000${entry.oldPath ?? ""}\u0000${entry.contentHash ?? MISSING_CONTENT_HASH}`;
}

/**
 * 对 Final ChangeSet 涉及的路径计算工作区状态指纹。
 *
 * - modified / added / renamed：读取目标路径当前内容计算 sha256；
 * - deleted：不读内容（状态本身即事实）；
 * - 文件按 path 排序后整体序列化，保证确定性。
 */
export async function captureReviewStateFingerprint(
	cwd: string,
	changes: readonly ReviewChange[],
): Promise<ReviewStateFingerprint> {
	const root = path.resolve(cwd);
	const entries: ReviewStateFingerprintEntry[] = [];
	for (const change of changes) {
		const entry: ReviewStateFingerprintEntry = {
			path: change.path,
			status: change.status,
			...(change.oldPath ? { oldPath: change.oldPath } : {}),
		};
		if (change.status !== "deleted") {
			const absolutePath = path.resolve(root, change.path);
			try {
				const content = await fs.promises.readFile(absolutePath);
				entry.contentHash = createHash("sha256").update(content).digest("hex");
			} catch {
				entry.contentHash = MISSING_CONTENT_HASH;
			}
		}
		entries.push(entry);
	}
	entries.sort((left, right) => {
		const byPath = left.path.localeCompare(right.path);
		if (byPath !== 0) return byPath;
		return (left.oldPath ?? "").localeCompare(right.oldPath ?? "");
	});
	const hash = createHash("sha256").update(entries.map(fingerprintEntryKey).join("\n")).digest("hex");
	return { hash, entries };
}

/** 两次指纹是否完全一致（相同的路径集合 + 相同的状态 + 相同的文件内容）。 */
export function reviewStateFingerprintsEqual(left: ReviewStateFingerprint, right: ReviewStateFingerprint): boolean {
	return left.hash === right.hash;
}
