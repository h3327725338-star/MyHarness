import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { lstat as lstatAsync, readdir as readdirAsync, rm as rmAsync } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.ts";
import { resolveGitRepositoryRoot } from "../../utils/paths.ts";
import { type GitCommandResult, runGit, runGitSync } from "../repository/command.ts";
import { runGitAsync } from "../repository/integration.ts";

/**
 * Git checkpoint：任务开始前保存本地仓库快照，任务后可恢复。
 *
 * 恢复承诺边界（documented edge cases）：
 * - 恢复范围是 worktree、index、HEAD、refs/*（排除 refs/myharness/checkpoints/**）；
 *   不承诺恢复 ignored 文件（.env、本地缓存等不进快照，恢复流程也不会主动清理它们）。
 * - 仓库外文件（如桌面路径）、global Git config、credential helper 不属于 repo checkpoint。
 * - remote 副作用（push 等）不会回滚，只通过 hadBashExecution 标记"外部副作用未知"；
 *   git push --mirror 等显式全 refs 操作可能把内部 checkpoint refs 推走，属 documented edge case。
 * - linked worktree 目录、submodule 内部 dirty 状态、进行中的 rebase/merge/cherry-pick
 *   内部状态（MERGE_HEAD、CHERRY_PICK_HEAD、.git/rebase-*、sequencer）不在恢复承诺内。
 */

const CHECKPOINT_VERSION = 2;
const LEGACY_CHECKPOINT_VERSION = 1;
const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESOLVED_CHECKPOINT_TTL_MS = 60 * 60 * 1000;
export const GIT_CHECKPOINT_TIMEOUT_MS = 180_000;

export type GitCheckpointStatus = "created" | "completed" | "retained" | "restored" | "deleted" | "invalid";

export type GitCheckpointToolName = "bash" | "edit" | "write" | "scan";

/**
 * 创建 checkpoint 的角色。当前只有主 Agent 会创建（delegated 子 Agent 不创建）。
 * 其余取值（user/external/system）与 id 只用于显示、审计和调试，
 * 不参与任何执行权限判断。
 */
export interface GitCheckpointActor {
	kind: "user" | "agent" | "external" | "system";
	id?: string;
	/** Agent 角色上下文（当前只有主 Agent 创建 checkpoint）。 */
	role?: "main";
}

export interface GitCheckpoint {
	version: number;
	id: string;
	sessionId: string;
	runId: string;
	actor?: GitCheckpointActor;
	/** 任务是否执行过不透明 Bash：本地 restore 无法验证或撤销其外部/远端副作用。 */
	hadBashExecution?: boolean;
	cwd: string;
	repositoryRoot: string;
	createdAt: string;
	headCommit?: string;
	headRef?: string;
	statusBeforeHash: string;
	/** Internal paths (for example runtime traces) that are never task changes. */
	excludedPaths?: string[];
	/** 任务开始时本地 refs（refs/*，排除 refs/myharness/checkpoints/**）的快照。 */
	localRefs?: Record<string, string>;
	localRefsState?: string;
	worktreeTree?: string;
	/** Independent baseline for the real Git index; preserves staged content. */
	indexTree?: string;
	checkpointRef?: string;
	indexCheckpointRef?: string;
	status: GitCheckpointStatus;
	/** Diagnostic detail when recovery could not be completed safely. */
	failureReason?: string;
	storagePath: string;
}

export interface GitCheckpointCreateResult {
	ok: boolean;
	checkpoint?: GitCheckpoint;
	error?: string;
	failureKind?: GitCommandResult["failureKind"];
}

export interface GitCheckpointMutationResult {
	ok: boolean;
	error?: string;
	observation?: GitCheckpointObservation;
}

export interface GitCheckpointObservation {
	headCommit?: string;
	headRef?: string;
	localRefs?: Record<string, string>;
	localRefsState?: string;
}

export interface GitCheckpointHeadChange {
	path: string;
	status: "added" | "modified" | "deleted";
}

export interface GitCheckpointRestoreResult {
	ok: boolean;
	checkpoint?: GitCheckpoint;
	error?: string;
	conflictPaths?: string[];
	cleanupError?: string;
	/** Opaque execution may have had external effects that local restore cannot verify or undo. */
	externalSideEffectsUnknown?: boolean;
}

export interface GitCheckpointDeleteResult {
	ok: boolean;
	error?: string;
	cleanupError?: string;
}

export interface GitCheckpointCleanupResult {
	removed: number;
	failed: string[];
}

export interface GitCheckpointLoadResult {
	ok: boolean;
	checkpoint?: GitCheckpoint;
	error?: string;
}

export interface GitCheckpointListResult {
	ok: boolean;
	checkpoints: GitCheckpoint[];
	failed: string[];
	error?: string;
}

export interface GitStatusEntry {
	code: string;
	path: string;
}

export function isGitStatusEntryUntracked(entry: GitStatusEntry): boolean {
	return entry.code === "??";
}

export function isGitStatusEntryStaged(entry: GitStatusEntry): boolean {
	const indexCode = entry.code[0];
	return entry.code !== "??" && entry.code !== "!!" && indexCode !== undefined && indexCode !== " ";
}

export function isGitStatusEntryWorkingTreeDirty(entry: GitStatusEntry): boolean {
	if (entry.code === "??") return true;
	const worktreeCode = entry.code[1];
	return entry.code !== "!!" && worktreeCode !== undefined && worktreeCode !== " ";
}

export interface GitCheckpointOptions {
	cwd: string;
	sessionId: string;
	runId?: string;
	storageRoot?: string;
	now?: () => Date;
	excludedPaths?: readonly string[];
}

function nowIso(now: () => Date): string {
	return now().toISOString();
}

function hashText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatGitFailure(result: GitCommandResult): string {
	const details = [result.error, result.stderr].filter((value): value is string => Boolean(value?.trim()));
	return details.length > 0 ? details.join("\n") : "Git 命令执行失败";
}

interface GitHeadState {
	commit?: string;
	ref?: string;
}

function lstatIfExists(absolutePath: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function lstatIfExistsAsync(absolutePath: string): Promise<Awaited<ReturnType<typeof lstatAsync>> | undefined> {
	try {
		return await lstatAsync(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function runCheckpointGit(
	cwd: string,
	args: string[],
	preserveOutput = false,
	env?: NodeJS.ProcessEnv,
	input?: string,
): GitCommandResult {
	return runGitSync(args, {
		cwd,
		timeoutMs: GIT_CHECKPOINT_TIMEOUT_MS,
		env: { GIT_OPTIONAL_LOCKS: "0", ...env },
		preserveOutput,
		input,
	});
}

/**
 * Async variant used on the interactive tool-call path.
 *
 * Snapshotting the worktree with `git add -A` re-hashes every tracked and
 * untracked file, which on a large repository takes many seconds. Running it
 * synchronously blocks the event loop for the whole duration, freezing the TUI
 * right after the user authorizes the first mutating tool call. Awaiting an
 * async subprocess keeps the UI responsive while the snapshot is built.
 */
async function runCheckpointGitAsync(
	cwd: string,
	args: string[],
	preserveOutput = false,
	env?: NodeJS.ProcessEnv,
	input?: string,
): Promise<GitCommandResult> {
	const result = await runGit(args, {
		cwd,
		timeoutMs: GIT_CHECKPOINT_TIMEOUT_MS,
		env: { GIT_OPTIONAL_LOCKS: "0", ...env },
		input,
	});
	// `runGit` returns raw stdout; `runGitSync` trims unless preserveOutput is
	// set. Match that contract so callers (e.g. `git write-tree`) receive a bare
	// oid instead of one with a trailing newline.
	if (preserveOutput) return result;
	return { ...result, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function sanitizeSegment(value: string): string {
	const result = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "_");
	return result || "unknown";
}

function normalizeRepositoryPath(repositoryRoot: string, inputPath: string): string {
	const absolutePath = resolve(repositoryRoot, inputPath);
	const relativePath = relative(repositoryRoot, absolutePath);
	if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
		throw new Error(`路径不在 Git 仓库内：${inputPath}`);
	}
	return relativePath.split(sep).join("/");
}

function resolveStoragePath(repositoryRoot: string, storageRoot: string): string {
	const resolvedRepositoryRoot = resolve(repositoryRoot);
	const resolvedStorageRoot = resolve(storageRoot);
	const physicalRepositoryRoot = resolvePhysicalPath(resolvedRepositoryRoot);
	const physicalStorageRoot = resolvePhysicalPath(resolvedStorageRoot);
	const fromRepository = relative(physicalRepositoryRoot, physicalStorageRoot);
	if (
		!fromRepository ||
		(!fromRepository.startsWith(`..${sep}`) && fromRepository !== ".." && !isAbsolute(fromRepository))
	) {
		throw new Error("检查点存储目录不能位于项目 Git 仓库内。请使用仓库外的私有目录。");
	}
	return resolvedStorageRoot;
}

/** Resolve existing junctions/symlinks while also supporting a not-yet-created path. */
function resolvePhysicalPath(inputPath: string): string {
	let current = resolve(inputPath);
	const missingParts: string[] = [];
	while (lstatIfExists(current) === undefined) {
		const parent = dirname(current);
		if (parent === current) return current;
		missingParts.unshift(basename(current));
		current = parent;
	}

	let physicalPath = realpathSync(current);
	for (const part of missingParts) physicalPath = join(physicalPath, part);
	return physicalPath;
}

function atomicWriteFile(filePath: string, content: string | Buffer, mode?: number): void {
	const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(tempPath, content, mode === undefined ? undefined : { mode });
	try {
		renameSync(tempPath, filePath);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Preserve the original rename error.
		}
		throw error;
	}
}

function writeMetadata(checkpoint: GitCheckpoint): void {
	// Re-check the physical destination every time metadata is written. A
	// junction/symlink can be replaced after checkpoint creation.
	resolveStoragePath(checkpoint.repositoryRoot, checkpoint.storagePath);
	const metadataPath = join(checkpoint.storagePath, "checkpoint.json");
	atomicWriteFile(metadataPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 0o600);
	try {
		chmodSync(metadataPath, 0o600);
	} catch {
		// Windows does not expose POSIX permissions. The directory ACL is still used.
	}
}

function readMetadata(storagePath: string): GitCheckpoint {
	const metadataPath = join(storagePath, "checkpoint.json");
	const checkpoint = JSON.parse(readFileSync(metadataPath, "utf8")) as GitCheckpoint;
	if (checkpoint.version !== CHECKPOINT_VERSION && checkpoint.version !== LEGACY_CHECKPOINT_VERSION) {
		throw new Error(`不支持的检查点版本：${checkpoint.version}`);
	}
	if (checkpoint.storagePath !== storagePath) {
		throw new Error("检查点元数据中的存储路径不一致。");
	}
	resolveStoragePath(checkpoint.repositoryRoot, storagePath);
	return checkpoint;
}

function parseNulSeparated(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

function parseGitStatus(value: string): GitStatusEntry[] {
	const tokens = value.split("\0");
	const entries: GitStatusEntry[] = [];
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

function getRepositoryRoot(cwd: string): {
	root?: string;
	error?: string;
	failureKind?: GitCommandResult["failureKind"];
} {
	const result = runCheckpointGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!result.ok || !result.stdout) {
		return { error: formatGitFailure(result), failureKind: result.failureKind };
	}
	return { root: resolveGitRepositoryRoot(cwd, result.stdout) };
}

function getHeadCommit(repositoryRoot: string): string | undefined {
	const result = runCheckpointGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
	return result.ok && result.stdout ? result.stdout : undefined;
}

function getHeadRef(repositoryRoot: string): string | undefined {
	const result = runCheckpointGit(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]);
	return result.ok && result.stdout ? result.stdout : undefined;
}

function getHeadState(repositoryRoot: string): GitHeadState {
	return { commit: getHeadCommit(repositoryRoot), ref: getHeadRef(repositoryRoot) };
}

function getLocalRefs(repositoryRoot: string): { refs?: Record<string, string>; error?: string } {
	const result = runCheckpointGit(
		repositoryRoot,
		["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"],
		true,
	);
	if (!result.ok) return { error: formatGitFailure(result) };
	const refs: Record<string, string> = {};
	for (const line of result.stdout.split(/\r?\n/gu)) {
		const [ref, sha] = line.split("\0");
		if (ref && sha && !ref.startsWith("refs/myharness/checkpoints/")) refs[ref] = sha;
	}
	return { refs };
}

function localRefsState(refs: Record<string, string>): string {
	return hashText(
		JSON.stringify(Object.fromEntries(Object.entries(refs).sort(([left], [right]) => left.localeCompare(right)))),
	);
}

function diffLocalRefs(
	before: Record<string, string> | undefined,
	after: Record<string, string> | undefined,
): GitCheckpointRefChange[] {
	if (!before || !after) return [];
	const changes: GitCheckpointRefChange[] = [];
	for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const previous = before[ref];
		const current = after[ref];
		if (previous === current) continue;
		changes.push({
			ref,
			kind: previous === undefined ? "created" : current === undefined ? "deleted" : "moved",
			...(previous === undefined ? {} : { before: previous }),
			...(current === undefined ? {} : { after: current }),
		});
	}
	return changes.sort((left, right) => left.ref.localeCompare(right.ref));
}

function getStatus(repositoryRoot: string): { output?: string; entries?: GitStatusEntry[]; error?: string } {
	const result = runCheckpointGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true);
	if (!result.ok) return { error: formatGitFailure(result) };
	return { output: result.stdout, entries: parseGitStatus(result.stdout) };
}

function statusHash(entries: readonly GitStatusEntry[], excludedPaths: readonly string[] = []): string {
	const excluded = excludedPaths.map((path) => path.replace(/\\/gu, "/"));
	return hashText(
		entries
			.map((entry) => ({ ...entry, path: entry.path.replace(/\\/gu, "/") }))
			.filter((entry) => !excluded.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)))
			.map((entry) => `${entry.code}\0${entry.path}`)
			.sort()
			.join("\0"),
	);
}

function getCheckpointObservation(repositoryRoot: string): {
	observation?: GitCheckpointObservation;
	error?: string;
} {
	const head = getHeadState(repositoryRoot);
	const refs = getLocalRefs(repositoryRoot);
	if (!refs.refs) return { error: refs.error ?? "无法读取 Git 本地 refs 状态。" };
	return {
		observation: {
			headCommit: head.commit,
			headRef: head.ref,
			localRefs: refs.refs,
			localRefsState: localRefsState(refs.refs),
		},
	};
}

function parseHeadChanges(value: string): GitCheckpointHeadChange[] {
	const tokens = parseNulSeparated(value);
	const changes: GitCheckpointHeadChange[] = [];
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		const code = tokens[index] ?? "";
		const path = tokens[index + 1];
		if (!path) continue;
		const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
		changes.push({ path, status });
	}
	return changes;
}

function createWorktreeTree(
	repositoryRoot: string,
	headCommit: string | undefined,
	storagePath: string,
	excludedPaths: readonly string[],
): Promise<{
	tree?: string;
	error?: string;
}> {
	const temporaryIndexPath = join(storagePath, "worktree.index");
	const env = { GIT_INDEX_FILE: temporaryIndexPath };
	return (async () => {
		try {
			const readTree = await runCheckpointGitAsync(
				repositoryRoot,
				headCommit ? ["read-tree", headCommit] : ["read-tree", "--empty"],
				false,
				env,
			);
			if (!readTree.ok) return { error: formatGitFailure(readTree) };
			const add = await runCheckpointGitAsync(
				repositoryRoot,
				["add", "-A", "--", ".", ...excludedPaths.map((path) => `:(exclude)${path}`)],
				false,
				env,
			);
			if (!add.ok) return { error: formatGitFailure(add) };
			const tree = await runCheckpointGitAsync(repositoryRoot, ["write-tree"], false, env);
			if (!tree.ok || !tree.stdout) return { error: formatGitFailure(tree) };
			return { tree: tree.stdout };
		} finally {
			try {
				rmSync(temporaryIndexPath, { force: true });
				rmSync(`${temporaryIndexPath}.lock`, { force: true });
			} catch {
				// The checkpoint directory remains available for diagnosis.
			}
		}
	})();
}

function deleteCheckpointReference(repositoryRoot: string, checkpointRef: string | undefined): string | undefined {
	if (!checkpointRef) return undefined;
	const result = runCheckpointGit(repositoryRoot, ["update-ref", "-d", checkpointRef]);
	return result.ok ? undefined : formatGitFailure(result);
}

/**
 * 删除 checkpoint 的全部 hidden refs（worktree 树 + index 树）。
 * 手动删除、自动清理和创建失败回滚共用同一逻辑，避免只删一半导致
 * index tree 对象残留、Git GC 无法回收。
 */
function deleteCheckpointReferences(
	repositoryRoot: string,
	checkpoint: Pick<GitCheckpoint, "checkpointRef" | "indexCheckpointRef">,
): string | undefined {
	const error = [
		deleteCheckpointReference(repositoryRoot, checkpoint.checkpointRef),
		deleteCheckpointReference(repositoryRoot, checkpoint.indexCheckpointRef),
	]
		.filter(Boolean)
		.join("\n");
	return error || undefined;
}

function updateCheckpointMetadata(checkpoint: GitCheckpoint): void {
	writeMetadata(checkpoint);
}

/** Persist an in-memory checkpoint update so it can be recovered after restart. */
export function persistGitCheckpoint(checkpoint: GitCheckpoint): void {
	updateCheckpointMetadata(checkpoint);
}

export function completeGitCheckpoint(checkpoint: GitCheckpoint): GitCheckpointMutationResult {
	if (checkpoint.status !== "created") {
		return { ok: false, error: `检查点当前状态为 ${checkpoint.status}，不能标记任务完成。` };
	}
	checkpoint.status = "completed";
	try {
		updateCheckpointMetadata(checkpoint);
		return { ok: true };
	} catch (error) {
		checkpoint.status = "created";
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 任务结束但未验证通过时关闭 checkpoint（PARTIAL / FAIL 后用户选择保留当前修改）。
 *
 * 语义：
 * - 任务已经结束、工作区修改继续保留；
 * - checkpoint 进入终态 retained，不再被下一次独立用户任务复用；
 * - 不是 completed（不表示验证通过），也不能再 restore / complete；
 * - 磁盘数据保留（不删除），按 resolved checkpoint 的 TTL 清理；
 * - listGitCheckpoints 只返回 created，因此 retained 不会被当成“上次未完成任务”触发 recovery。
 */
export function retainGitCheckpoint(checkpoint: GitCheckpoint): GitCheckpointMutationResult {
	if (checkpoint.status !== "created") {
		return { ok: false, error: `检查点当前状态为 ${checkpoint.status}，不能标记为保留。` };
	}
	checkpoint.status = "retained";
	try {
		updateCheckpointMetadata(checkpoint);
		return { ok: true };
	} catch (error) {
		checkpoint.status = "created";
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Close a checkpoint after recovery itself failed. `invalid` is intentionally
 * distinct from `retained`: the workspace may need manual inspection, and the
 * checkpoint must not keep the interactive session in an endless decision
 * state or be offered automatically after restart.
 */
export function invalidateGitCheckpoint(checkpoint: GitCheckpoint, reason: string): GitCheckpointMutationResult {
	if (checkpoint.status !== "created") {
		return { ok: false, error: `检查点当前状态为 ${checkpoint.status}，不能标记为恢复失败。` };
	}
	const previousReason = checkpoint.failureReason;
	checkpoint.status = "invalid";
	checkpoint.failureReason = reason;
	try {
		updateCheckpointMetadata(checkpoint);
		return { ok: true };
	} catch (error) {
		checkpoint.status = "created";
		checkpoint.failureReason = previousReason;
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

interface GitCheckpointRefChange {
	ref: string;
	kind: "created" | "deleted" | "moved";
	before?: string;
	after?: string;
}

export function collectGitCheckpointLocalRefChanges(checkpoint: GitCheckpoint): GitCheckpointRefChange[] {
	const current = getLocalRefs(checkpoint.repositoryRoot);
	return current.refs ? diffLocalRefs(checkpoint.localRefs, current.refs) : [];
}

export async function observeGitCheckpointFinalState(
	checkpoint: GitCheckpoint,
): Promise<{ observation?: GitCheckpointObservation; error?: string }> {
	return getCheckpointObservation(checkpoint.repositoryRoot);
}

export function collectGitCheckpointHeadChanges(checkpoint: GitCheckpoint): {
	changes?: GitCheckpointHeadChange[];
	error?: string;
} {
	const current = getHeadState(checkpoint.repositoryRoot);
	if (!checkpoint.headCommit || !current.commit || checkpoint.headCommit === current.commit) return { changes: [] };
	const result = runCheckpointGit(
		checkpoint.repositoryRoot,
		["diff", "--name-status", "-z", "--no-renames", checkpoint.headCommit, current.commit, "--"],
		true,
	);
	if (!result.ok) return { error: formatGitFailure(result) };
	return { changes: parseHeadChanges(result.stdout) };
}

function parseGitNameStatus(value: string): GitCheckpointHeadChange[] {
	const tokens = parseNulSeparated(value);
	const changes: GitCheckpointHeadChange[] = [];
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		const code = tokens[index] ?? "";
		const path = tokens[index + 1];
		if (!path) continue;
		changes.push({
			path,
			status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
		});
	}
	return changes;
}

function isIndexPathAtWorktreeBaseline(checkpoint: GitCheckpoint, path: string): { same?: boolean; error?: string } {
	if (!checkpoint.worktreeTree) return { error: "checkpoint 缺少工作区基线树。" };
	const result = runCheckpointGit(checkpoint.repositoryRoot, [
		"diff",
		"--cached",
		"--quiet",
		"--no-renames",
		checkpoint.worktreeTree,
		"--",
		path,
	]);
	if (result.ok) return { same: true };
	if (result.exitCode === 1) return { same: false };
	return { error: formatGitFailure(result) };
}

async function isIndexPathAtWorktreeBaselineAsync(
	checkpoint: GitCheckpoint,
	path: string,
): Promise<{ same?: boolean; error?: string }> {
	if (!checkpoint.worktreeTree) return { error: "checkpoint 缺少工作区基线树。" };
	const result = await runCheckpointGitAsync(checkpoint.repositoryRoot, [
		"diff",
		"--cached",
		"--quiet",
		"--no-renames",
		checkpoint.worktreeTree,
		"--",
		path,
	]);
	if (result.ok) return { same: true };
	if (result.exitCode === 1) return { same: false };
	return { error: formatGitFailure(result) };
}

/**
 * Compare the checkpoint's saved worktree tree with the repository as it is
 * now. This is intentionally independent of tool calls and command parsing.
 */
export function collectGitCheckpointWorkingTreeChanges(checkpoint: GitCheckpoint): {
	changes?: GitCheckpointHeadChange[];
	error?: string;
} {
	if (!checkpoint.worktreeTree) return { error: "checkpoint 缺少工作区基线树。" };
	const changes = new Map<string, GitCheckpointHeadChange>();
	const baseline = runCheckpointGit(
		checkpoint.repositoryRoot,
		["ls-tree", "-r", "-z", "--name-only", checkpoint.worktreeTree],
		true,
	);
	if (!baseline.ok) return { error: formatGitFailure(baseline) };
	const baselinePaths = new Set(parseNulSeparated(baseline.stdout));
	// 真实 index 中的 tracked 路径。基线 tree 快照过的 untracked 文件不在其中，
	// 不能参与 index/worktree diff（会被误报为 deleted），改用 blob 内容对比。
	const trackedResult = runCheckpointGit(checkpoint.repositoryRoot, ["ls-files", "-z"], true);
	if (!trackedResult.ok) return { error: formatGitFailure(trackedResult) };
	const tracked = new Set(parseNulSeparated(trackedResult.stdout));
	const worktreeDiff = runCheckpointGit(
		checkpoint.repositoryRoot,
		["diff", "--name-status", "-z", "--no-renames", checkpoint.worktreeTree, "--"],
		true,
	);
	if (!worktreeDiff.ok) return { error: formatGitFailure(worktreeDiff) };
	for (const change of parseGitNameStatus(worktreeDiff.stdout)) {
		if (baselinePaths.has(change.path) && !tracked.has(change.path)) continue;
		changes.set(change.path, change);
	}

	const indexDiff = runCheckpointGit(
		checkpoint.repositoryRoot,
		[
			"diff",
			"--cached",
			"--name-status",
			"-z",
			"--no-renames",
			checkpoint.indexTree ?? checkpoint.worktreeTree,
			"--",
		],
		true,
	);
	if (!indexDiff.ok) return { error: formatGitFailure(indexDiff) };
	for (const change of parseGitNameStatus(indexDiff.stdout)) {
		if (baselinePaths.has(change.path) && !tracked.has(change.path)) continue;
		if (!changes.has(change.path)) {
			const baseline = isIndexPathAtWorktreeBaseline(checkpoint, change.path);
			if (baseline.error) return { error: baseline.error };
			if (baseline.same) continue;
		}
		changes.set(change.path, change);
	}

	// 基线快照过的 untracked 文件：把当前工作区内容与基线 blob 对比。
	for (const path of baselinePaths) {
		if (tracked.has(path)) continue;
		const baselineOid = runCheckpointGit(
			checkpoint.repositoryRoot,
			["rev-parse", "--verify", `${checkpoint.worktreeTree}:${path}`],
			true,
		);
		if (!baselineOid.ok || !baselineOid.stdout) return { error: formatGitFailure(baselineOid) };
		const currentPath = resolve(checkpoint.repositoryRoot, path);
		const stat = lstatIfExists(currentPath);
		if (!stat) {
			changes.set(path, { path, status: "deleted" });
			continue;
		}
		const currentOid = runCheckpointGit(checkpoint.repositoryRoot, ["hash-object", currentPath], true);
		if (!currentOid.ok || !currentOid.stdout) return { error: formatGitFailure(currentOid) };
		if (currentOid.stdout !== baselineOid.stdout) {
			changes.set(path, { path, status: "modified" });
		}
	}

	const untracked = runCheckpointGit(
		checkpoint.repositoryRoot,
		["ls-files", "--others", "--exclude-standard", "-z"],
		true,
	);
	if (!untracked.ok) return { error: formatGitFailure(untracked) };
	for (const path of parseNulSeparated(untracked.stdout)) {
		if (!baselinePaths.has(path)) changes.set(path, { path, status: "added" });
	}
	const excludedPaths = (checkpoint.excludedPaths ?? []).map((path) => path.replace(/\\/gu, "/"));
	return {
		changes: [...changes.values()]
			.filter(
				(change) =>
					!excludedPaths.some((excluded) => change.path === excluded || change.path.startsWith(`${excluded}/`)),
			)
			.sort((left, right) => left.path.localeCompare(right.path)),
	};
}

/** Async counterpart for interactive recovery decisions; never blocks the TUI on Git subprocesses. */
export async function collectGitCheckpointWorkingTreeChangesAsync(checkpoint: GitCheckpoint): Promise<{
	changes?: GitCheckpointHeadChange[];
	error?: string;
}> {
	if (!checkpoint.worktreeTree) return { error: "checkpoint 缺少工作区基线树。" };
	const changes = new Map<string, GitCheckpointHeadChange>();
	const baseline = await runCheckpointGitAsync(
		checkpoint.repositoryRoot,
		["ls-tree", "-r", "-z", "--name-only", checkpoint.worktreeTree],
		true,
	);
	if (!baseline.ok) return { error: formatGitFailure(baseline) };
	const baselinePaths = new Set(parseNulSeparated(baseline.stdout));
	const trackedResult = await runCheckpointGitAsync(checkpoint.repositoryRoot, ["ls-files", "-z"], true);
	if (!trackedResult.ok) return { error: formatGitFailure(trackedResult) };
	const tracked = new Set(parseNulSeparated(trackedResult.stdout));
	const worktreeDiff = await runCheckpointGitAsync(
		checkpoint.repositoryRoot,
		["diff", "--name-status", "-z", "--no-renames", checkpoint.worktreeTree, "--"],
		true,
	);
	if (!worktreeDiff.ok) return { error: formatGitFailure(worktreeDiff) };
	for (const change of parseGitNameStatus(worktreeDiff.stdout)) {
		if (baselinePaths.has(change.path) && !tracked.has(change.path)) continue;
		changes.set(change.path, change);
	}

	const indexDiff = await runCheckpointGitAsync(
		checkpoint.repositoryRoot,
		[
			"diff",
			"--cached",
			"--name-status",
			"-z",
			"--no-renames",
			checkpoint.indexTree ?? checkpoint.worktreeTree,
			"--",
		],
		true,
	);
	if (!indexDiff.ok) return { error: formatGitFailure(indexDiff) };
	for (const change of parseGitNameStatus(indexDiff.stdout)) {
		if (baselinePaths.has(change.path) && !tracked.has(change.path)) continue;
		if (!changes.has(change.path)) {
			const baseline = await isIndexPathAtWorktreeBaselineAsync(checkpoint, change.path);
			if (baseline.error) return { error: baseline.error };
			if (baseline.same) continue;
		}
		changes.set(change.path, change);
	}

	for (const path of baselinePaths) {
		if (tracked.has(path)) continue;
		const baselineOid = await runCheckpointGitAsync(
			checkpoint.repositoryRoot,
			["rev-parse", "--verify", `${checkpoint.worktreeTree}:${path}`],
			true,
		);
		if (!baselineOid.ok || !baselineOid.stdout) return { error: formatGitFailure(baselineOid) };
		const currentPath = resolve(checkpoint.repositoryRoot, path);
		const stat = await lstatIfExistsAsync(currentPath);
		if (!stat) {
			changes.set(path, { path, status: "deleted" });
			continue;
		}
		const currentOid = await runCheckpointGitAsync(checkpoint.repositoryRoot, ["hash-object", currentPath], true);
		if (!currentOid.ok || !currentOid.stdout) return { error: formatGitFailure(currentOid) };
		if (currentOid.stdout !== baselineOid.stdout) {
			changes.set(path, { path, status: "modified" });
		}
	}

	const untracked = await runCheckpointGitAsync(
		checkpoint.repositoryRoot,
		["ls-files", "--others", "--exclude-standard", "-z"],
		true,
	);
	if (!untracked.ok) return { error: formatGitFailure(untracked) };
	for (const path of parseNulSeparated(untracked.stdout)) {
		if (!baselinePaths.has(path)) changes.set(path, { path, status: "added" });
	}
	const excludedPaths = (checkpoint.excludedPaths ?? []).map((path) => path.replace(/\\/gu, "/"));
	return {
		changes: [...changes.values()]
			.filter(
				(change) =>
					!excludedPaths.some((excluded) => change.path === excluded || change.path.startsWith(`${excluded}/`)),
			)
			.sort((left, right) => left.path.localeCompare(right.path)),
	};
}

/** Materialize the saved worktree tree into an isolated review workspace. */
export function restoreGitCheckpointBaselineWorkspace(
	checkpoint: GitCheckpoint,
	workspacePath: string,
): { ok: boolean; error?: string } {
	if (!checkpoint.worktreeTree) return { ok: false, error: "checkpoint 缺少工作区基线树。" };
	const workspaceRoot = resolve(workspacePath);
	const repositoryRoot = resolve(checkpoint.repositoryRoot);
	const changed = collectGitCheckpointWorkingTreeChanges(checkpoint);
	if (!changed.changes) return { ok: false, error: changed.error };

	try {
		for (const change of changed.changes) {
			const target = resolve(workspaceRoot, change.path);
			const relation = relative(workspaceRoot, target);
			if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
				return { ok: false, error: `review baseline 路径越界：${change.path}` };
			}
			const stat = lstatIfExists(target);
			if (stat) rmSync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: false });
		}

		const temporaryIndexPath = join(checkpoint.storagePath, `review-baseline-${randomUUID()}.index`);
		const env = { GIT_INDEX_FILE: temporaryIndexPath };
		try {
			const readTree = runCheckpointGit(repositoryRoot, ["read-tree", checkpoint.worktreeTree], false, env);
			if (!readTree.ok) return { ok: false, error: formatGitFailure(readTree) };
			const checkout = runCheckpointGit(
				repositoryRoot,
				["--work-tree", workspaceRoot, "checkout-index", "--all", "--force"],
				false,
				env,
			);
			return checkout.ok ? { ok: true } : { ok: false, error: formatGitFailure(checkout) };
		} finally {
			rmSync(temporaryIndexPath, { force: true });
			rmSync(`${temporaryIndexPath}.lock`, { force: true });
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function getGitCheckpointPendingTaskPaths(checkpoint: GitCheckpoint): { paths?: string[]; error?: string } {
	const status = getStatus(checkpoint.repositoryRoot);
	if (!status.entries) return { error: status.error ?? "无法读取当前 Git 工作区状态。" };
	const excluded = (checkpoint.excludedPaths ?? []).map((path) => path.replace(/\\/gu, "/"));
	const paths = status.entries
		.map((entry) => entry.path.replace(/\\/gu, "/"))
		.filter((path) => !excluded.some((excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}/`)));
	return { paths: [...new Set(paths)].sort() };
}

/**
 * 异步版 getGitCheckpointPendingTaskPaths：git status 通过异步 runGit 执行，
 * 不阻塞事件循环（供后台提交任务使用）。
 */
export async function getGitWorkingTreePathsAsync(
	repositoryRoot: string,
	excludedPaths: readonly string[] = [],
	signal?: AbortSignal,
): Promise<{ paths?: string[]; error?: string }> {
	const result = await runGitAsync(
		repositoryRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		GIT_CHECKPOINT_TIMEOUT_MS,
		signal,
	);
	if (!result.ok) return { error: formatGitFailure(result) };
	const excluded = excludedPaths.map((path) => path.replace(/\\/gu, "/"));
	const paths = parseGitStatus(result.stdout)
		.map((entry) => entry.path.replace(/\\/gu, "/"))
		.filter((path) => !excluded.some((excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}/`)));
	return { paths: [...new Set(paths)].sort() };
}

export async function getGitCheckpointPendingTaskPathsAsync(
	checkpoint: GitCheckpoint,
	signal?: AbortSignal,
): Promise<{ paths?: string[]; error?: string }> {
	return getGitWorkingTreePathsAsync(checkpoint.repositoryRoot, checkpoint.excludedPaths ?? [], signal);
}

/** Checkpoint task changes are the real repository delta from its saved baseline. */
export function hasGitCheckpointTaskChanges(checkpoint: GitCheckpoint): boolean {
	let workingTree: ReturnType<typeof collectGitCheckpointWorkingTreeChanges>;
	try {
		workingTree = collectGitCheckpointWorkingTreeChanges(checkpoint);
	} catch {
		return true;
	}
	// The status code/path hash is only a cheap index of Git state. It cannot
	// distinguish a file whose content was changed before the checkpoint and
	// then changed again by the task. Prefer the tree/blob comparison whenever
	// a v2 baseline is available; if inspection fails, fail closed and keep the
	// recovery decision visible instead of silently taking the no-op path.
	if (checkpoint.worktreeTree) {
		if (workingTree.changes) {
			if (workingTree.changes.length > 0) return true;
		} else {
			return true;
		}
	}

	const status = getStatus(checkpoint.repositoryRoot);
	if (!status.entries || statusHash(status.entries, checkpoint.excludedPaths) !== checkpoint.statusBeforeHash)
		return true;
	const head = getHeadState(checkpoint.repositoryRoot);
	if (head.commit !== checkpoint.headCommit || head.ref !== checkpoint.headRef) return true;
	const refs = getLocalRefs(checkpoint.repositoryRoot);
	return refs.refs === undefined || localRefsState(refs.refs) !== checkpoint.localRefsState;
}

/** Async counterpart used before opening a recovery decision in the interactive UI. */
export async function hasGitCheckpointTaskChangesAsync(checkpoint: GitCheckpoint): Promise<boolean> {
	try {
		if (checkpoint.worktreeTree) {
			const workingTree = await collectGitCheckpointWorkingTreeChangesAsync(checkpoint);
			if (!workingTree.changes) return true;
			if (workingTree.changes.length > 0) return true;
		}

		const statusResult = await runCheckpointGitAsync(
			checkpoint.repositoryRoot,
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			true,
		);
		const statusEntries = statusResult.ok ? parseGitStatus(statusResult.stdout) : undefined;
		if (!statusEntries || statusHash(statusEntries, checkpoint.excludedPaths) !== checkpoint.statusBeforeHash)
			return true;
		const [head, refs] = await Promise.all([
			getHeadStateAsync(checkpoint.repositoryRoot),
			getLocalRefsAsync(checkpoint.repositoryRoot),
		]);
		if (head.commit !== checkpoint.headCommit || head.ref !== checkpoint.headRef) return true;
		return refs.refs === undefined || localRefsState(refs.refs) !== checkpoint.localRefsState;
	} catch {
		// Recovery decisions must fail closed: an inspection error is a reason to
		// show the user a decision, never a reason to silently skip recovery.
		return true;
	}
}

function createCheckpointId(sessionId: string, runId: string, timestamp: number): string {
	// The ID is also used as a directory name. Do not embed the full session and
	// run IDs here: on Windows that can make the temporary GIT_INDEX_FILE path
	// exceed MAX_PATH before `git read-tree` can create it. The full values remain
	// in checkpoint.json for diagnostics and recovery.
	const scope = hashText(`${sessionId}\0${runId}`).slice(0, 12);
	return `checkpoint-${timestamp}-${scope}-${randomUUID().slice(0, 8)}`;
}

function checkpointStorageRoot(repositoryRoot: string, storageRoot?: string): string {
	const configuredRoot = storageRoot ?? join(getAgentDir(), "checkpoints");
	return resolveStoragePath(repositoryRoot, configuredRoot);
}

export function loadGitCheckpoint(storagePath: string): GitCheckpointLoadResult {
	const resolvedStoragePath = resolve(storagePath);
	try {
		return { ok: true, checkpoint: readMetadata(resolvedStoragePath) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function listGitCheckpoints(options: {
	cwd: string;
	sessionId?: string;
	storageRoot?: string;
}): GitCheckpointListResult {
	const repository = getRepositoryRoot(options.cwd);
	if (!repository.root) {
		return { ok: false, checkpoints: [], failed: [], error: repository.error ?? "无法定位 Git 仓库。" };
	}

	let storageRoot: string;
	try {
		storageRoot = checkpointStorageRoot(repository.root, options.storageRoot);
	} catch (error) {
		return { ok: false, checkpoints: [], failed: [], error: error instanceof Error ? error.message : String(error) };
	}

	const checkpoints: GitCheckpoint[] = [];
	const failed: string[] = [];
	try {
		const sessionNames = options.sessionId ? [sanitizeSegment(options.sessionId)] : safeDirectoryNames(storageRoot);
		for (const sessionName of sessionNames) {
			const sessionPath = join(storageRoot, sessionName);
			for (const checkpointName of safeDirectoryNames(sessionPath)) {
				if (!checkpointName.startsWith("checkpoint-")) continue;
				const checkpointPath = join(sessionPath, checkpointName);
				const loaded = loadGitCheckpoint(checkpointPath);
				if (!loaded.ok || !loaded.checkpoint) {
					failed.push(checkpointPath);
					continue;
				}
				if (
					loaded.checkpoint.status === "created" &&
					resolve(loaded.checkpoint.repositoryRoot) === resolve(repository.root) &&
					(!options.sessionId || loaded.checkpoint.sessionId === options.sessionId)
				) {
					checkpoints.push(loaded.checkpoint);
				}
			}
		}
	} catch (error) {
		return {
			ok: false,
			checkpoints,
			failed,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return { ok: true, checkpoints, failed };
}

export async function createGitCheckpoint(options: GitCheckpointOptions): Promise<GitCheckpointCreateResult> {
	const repository = getRepositoryRoot(options.cwd);
	if (!repository.root) {
		return { ok: false, error: repository.error, failureKind: repository.failureKind };
	}

	let storageRoot: string;
	try {
		storageRoot = checkpointStorageRoot(repository.root, options.storageRoot);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const now = options.now ?? (() => new Date());
	const runId = options.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const timestamp = now().getTime();
	const id = createCheckpointId(options.sessionId, runId, timestamp);
	const storagePath = join(storageRoot, sanitizeSegment(options.sessionId), id);
	const excludedPaths = (options.excludedPaths ?? []).flatMap((candidate) => {
		const relativePath = relative(repository.root!, resolve(candidate));
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			return [];
		}
		return [relativePath.split(sep).join("/")];
	});
	let checkpointRef: string | undefined;
	let indexCheckpointRef: string | undefined;

	try {
		cleanupGitCheckpoints({ storageRoot, sessionId: options.sessionId, now });
		mkdirSync(storagePath, { recursive: true, mode: 0o700 });

		const status = getStatus(repository.root);
		if (status.output === undefined || !status.entries) throw new Error(status.error ?? "无法读取 Git 工作区状态。");
		const observation = getCheckpointObservation(repository.root);
		if (!observation.observation) throw new Error(observation.error ?? "无法读取 Git checkpoint 基线。");
		const head = { commit: observation.observation.headCommit, ref: observation.observation.headRef };
		const indexTree = runCheckpointGit(repository.root, ["write-tree"]);
		if (!indexTree.ok || !indexTree.stdout) throw new Error(formatGitFailure(indexTree));
		const worktreeTreeResult = await createWorktreeTree(repository.root, head.commit, storagePath, excludedPaths);
		if (!worktreeTreeResult.tree) throw new Error(worktreeTreeResult.error ?? "无法保存 Git 工作区检查点。");
		const worktreeTree = worktreeTreeResult.tree;
		const refs = observation.observation.localRefs;
		if (!refs) throw new Error("无法保存 Git 本地 refs 状态。");
		checkpointRef = `refs/myharness/checkpoints/${sanitizeSegment(options.sessionId)}/${id}/worktree`;
		indexCheckpointRef = `refs/myharness/checkpoints/${sanitizeSegment(options.sessionId)}/${id}/index`;
		const refResult = runCheckpointGit(repository.root, ["update-ref", checkpointRef, worktreeTree]);
		if (!refResult.ok) throw new Error(formatGitFailure(refResult));
		const indexRefResult = runCheckpointGit(repository.root, ["update-ref", indexCheckpointRef, indexTree.stdout]);
		if (!indexRefResult.ok) throw new Error(formatGitFailure(indexRefResult));

		const checkpoint: GitCheckpoint = {
			version: CHECKPOINT_VERSION,
			id,
			sessionId: options.sessionId,
			runId,
			actor: { kind: "agent", role: "main" },
			cwd: resolve(options.cwd),
			repositoryRoot: repository.root,
			createdAt: nowIso(now),
			headCommit: head.commit,
			headRef: head.ref,
			statusBeforeHash: statusHash(status.entries, excludedPaths),
			excludedPaths,
			localRefs: refs,
			localRefsState: localRefsState(refs),
			worktreeTree,
			indexTree: indexTree.stdout,
			checkpointRef,
			indexCheckpointRef,
			status: "created",
			storagePath,
		};

		writeMetadata(checkpoint);
		return { ok: true, checkpoint };
	} catch (error) {
		const referenceError = deleteCheckpointReferences(repository.root, { checkpointRef, indexCheckpointRef });
		try {
			rmSync(storagePath, { recursive: true, force: true });
		} catch {
			// The original creation error is more useful to the caller.
		}
		const creationError = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: referenceError ? `${creationError}\n检查点私有引用清理失败：${referenceError}` : creationError,
		};
	}
}

function resolveMutationPath(checkpoint: GitCheckpoint, mutationPath: string): string {
	return normalizeRepositoryPath(checkpoint.repositoryRoot, resolve(checkpoint.cwd, mutationPath));
}

/**
 * 判断目标路径是否位于检查点仓库内。
 * 项目仓库外的文件（如桌面等路径）不参与检查点记录：调用方在 checkpoint
 * 创建后据此跳过记录与恢复。仓库外写入不会先于 checkpoint 创建被识别
 * （repositoryRoot 来自 checkpoint），因此首次仓库外写入仍会产生一次
 * checkpoint 快照，代价是一次/任务的额外开销；仓库外文件本身不受影响。
 */
export function isPathInsideRepository(checkpoint: GitCheckpoint, mutationPath: string): boolean {
	try {
		resolveMutationPath(checkpoint, mutationPath);
		return true;
	} catch {
		return false;
	}
}

async function getHeadStateAsync(repositoryRoot: string): Promise<GitHeadState> {
	const [commit, ref] = await Promise.all([
		runCheckpointGitAsync(repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
		runCheckpointGitAsync(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"]),
	]);
	return {
		commit: commit.ok && commit.stdout ? commit.stdout : undefined,
		ref: ref.ok && ref.stdout ? ref.stdout : undefined,
	};
}

async function getLocalRefsAsync(repositoryRoot: string): Promise<{ refs?: Record<string, string>; error?: string }> {
	const result = await runCheckpointGitAsync(
		repositoryRoot,
		["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"],
		true,
	);
	if (!result.ok) return { error: formatGitFailure(result) };
	const refs: Record<string, string> = {};
	for (const line of result.stdout.split(/\r?\n/gu)) {
		const [ref, sha] = line.split("\0");
		if (ref && sha && !ref.startsWith("refs/myharness/checkpoints/")) refs[ref] = sha;
	}
	return { refs };
}

async function restoreCheckpointRefs(
	repositoryRoot: string,
	refs: Record<string, string>,
): Promise<string | undefined> {
	// 批量恢复：git update-ref --stdin 一次事务写入全部 refs 快照。
	// 注意行模式要求每条 update 以 LF 终止，最后一行也不能省略。
	const entries = Object.entries(refs);
	if (entries.length === 0) return undefined;
	const input = `${entries.map(([ref, oid]) => `update ${ref} ${oid}`).join("\n")}\n`;
	const result = await runCheckpointGitAsync(repositoryRoot, ["update-ref", "--stdin"], false, undefined, input);
	return result.ok ? undefined : formatGitFailure(result);
}

async function removeCheckpointNewRefs(
	repositoryRoot: string,
	refs: Record<string, string>,
): Promise<string | undefined> {
	const current = await getLocalRefsAsync(repositoryRoot);
	if (!current.refs) return current.error ?? "无法读取当前 refs。";
	// 批量删除 checkpoint 后新增的 refs（快照中不存在的），与恢复同一事务方式。
	const deletions = Object.keys(current.refs)
		.filter((ref) => refs[ref] === undefined)
		.map((ref) => `delete ${ref}`);
	if (deletions.length === 0) return undefined;
	const result = await runCheckpointGitAsync(
		repositoryRoot,
		["update-ref", "--stdin"],
		false,
		undefined,
		`${deletions.join("\n")}\n`,
	);
	return result.ok ? undefined : formatGitFailure(result);
}

async function restoreCheckpointHead(repositoryRoot: string, checkpoint: GitCheckpoint): Promise<string | undefined> {
	return restoreGitHeadState(repositoryRoot, { ref: checkpoint.headRef, commit: checkpoint.headCommit });
}

async function restoreGitHeadState(repositoryRoot: string, head: GitHeadState): Promise<string | undefined> {
	if (head.ref) {
		const result = await runCheckpointGitAsync(repositoryRoot, ["symbolic-ref", "HEAD", head.ref]);
		return result.ok ? undefined : formatGitFailure(result);
	}
	if (!head.commit) return undefined;
	const update = await runCheckpointGitAsync(repositoryRoot, ["update-ref", "--no-deref", "HEAD", head.commit]);
	return update.ok ? undefined : formatGitFailure(update);
}

async function getCheckpointAddedUntrackedPaths(
	checkpoint: GitCheckpoint,
): Promise<{ paths?: string[]; error?: string; baselinePaths?: Set<string> }> {
	if (!checkpoint.worktreeTree) return { error: "checkpoint 缺少工作区基线树。" };
	const baseline = await runCheckpointGitAsync(
		checkpoint.repositoryRoot,
		["ls-tree", "-r", "-z", "--name-only", checkpoint.worktreeTree],
		true,
	);
	if (!baseline.ok) return { error: formatGitFailure(baseline) };
	const baselinePaths = new Set(parseNulSeparated(baseline.stdout));
	const untracked = await runCheckpointGitAsync(
		checkpoint.repositoryRoot,
		["ls-files", "--others", "--exclude-standard", "-z"],
		true,
	);
	if (!untracked.ok) return { error: formatGitFailure(untracked) };
	const excluded = (checkpoint.excludedPaths ?? []).map((path) => path.replace(/\\/gu, "/"));
	const paths = parseNulSeparated(untracked.stdout)
		.filter((path) => !baselinePaths.has(path))
		.filter((path) => !excluded.some((excludedPath) => path === excludedPath || path.startsWith(`${excludedPath}/`)));
	return { paths, baselinePaths };
}

async function containsGitMetadata(directoryPath: string): Promise<boolean> {
	try {
		const entries = await readdirAsync(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git") return true;
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (await containsGitMetadata(join(directoryPath, entry.name))) return true;
		}
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function removeEmptyCheckpointParentDirectories(
	repositoryRoot: string,
	targetPath: string,
	baselinePaths: ReadonlySet<string>,
): Promise<void> {
	const resolvedRepositoryRoot = resolve(repositoryRoot);
	let current = dirname(targetPath);
	while (current !== resolvedRepositoryRoot) {
		const relation = relative(resolvedRepositoryRoot, current);
		if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return;
		const normalized = relation.split(sep).join("/");
		if ([...baselinePaths].some((path) => path === normalized || path.startsWith(`${normalized}/`))) return;
		const stat = await lstatIfExistsAsync(current);
		if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
		const entries = await readdirAsync(current);
		if (entries.length > 0) return;
		await rmAsync(current, { recursive: true, force: true });
		current = dirname(current);
	}
}

async function removeCheckpointAddedUntrackedPaths(
	checkpoint: GitCheckpoint,
	paths: readonly string[],
	baselinePaths: ReadonlySet<string>,
): Promise<string | undefined> {
	const repositoryRoot = resolve(checkpoint.repositoryRoot);
	try {
		for (const relativePath of paths) {
			const target = resolve(repositoryRoot, relativePath);
			const relation = relative(repositoryRoot, target);
			if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
				return `恢复路径越界：${relativePath}`;
			}
			const stat = await lstatIfExistsAsync(target);
			if (!stat) continue;
			if (stat.isDirectory() && !stat.isSymbolicLink() && (await containsGitMetadata(target))) {
				// 与既有恢复承诺一致：嵌套 Git 仓库不是外层 checkpoint 的内容，保留它。
				continue;
			}
			// `recursive: true` is safe here because `target` is one exact path
			// reported as a new untracked path, never a repository-wide pathspec.
			await rmAsync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
			await removeEmptyCheckpointParentDirectories(repositoryRoot, target, baselinePaths);
		}
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function restoreTreeCheckpoint(checkpoint: GitCheckpoint): Promise<GitCheckpointRestoreResult> {
	if (!checkpoint.worktreeTree || !checkpoint.indexTree || !checkpoint.localRefs) {
		return { ok: false, checkpoint, error: "checkpoint 缺少 worktree、index 或 refs 快照。" };
	}
	// 记录恢复前的 refs/HEAD：恢复中途失败时尽量回滚 Git 元数据，
	// 避免仓库停留在"HEAD/refs 已恢复但工作区未恢复"的混合状态。
	const previousRefsResult = await getLocalRefsAsync(checkpoint.repositoryRoot);
	if (!previousRefsResult.refs) {
		return { ok: false, checkpoint, error: `读取恢复前 refs 失败：${previousRefsResult.error ?? "未知错误"}` };
	}
	const previousRefs = previousRefsResult.refs;
	const previousHead = await getHeadStateAsync(checkpoint.repositoryRoot);
	try {
		const addedUntracked = await getCheckpointAddedUntrackedPaths(checkpoint);
		if (!addedUntracked.paths || !addedUntracked.baselinePaths) {
			throw new Error(`读取 checkpoint 新增未跟踪路径失败：${addedUntracked.error ?? "未知错误"}`);
		}

		const refsError = await restoreCheckpointRefs(checkpoint.repositoryRoot, checkpoint.localRefs);
		if (refsError) throw new Error(`恢复 refs 失败：${refsError}`);
		const headError = await restoreCheckpointHead(checkpoint.repositoryRoot, checkpoint);
		if (headError) throw new Error(`恢复 HEAD 失败：${headError}`);
		const deleteRefsError = await removeCheckpointNewRefs(checkpoint.repositoryRoot, checkpoint.localRefs);
		if (deleteRefsError) throw new Error(`删除 checkpoint 后新增的 refs 失败：${deleteRefsError}`);

		// A checkpoint is a recovery mechanism. Do not infer what the prior Git
		// command meant: materialize its saved worktree, then restore its index.
		const cleanupError = await removeCheckpointAddedUntrackedPaths(
			checkpoint,
			addedUntracked.paths,
			addedUntracked.baselinePaths,
		);
		if (cleanupError) throw new Error(`移除 checkpoint 后新增的未跟踪文件失败：${cleanupError}`);
		const worktree = await runCheckpointGitAsync(checkpoint.repositoryRoot, [
			"read-tree",
			"--reset",
			"-u",
			checkpoint.worktreeTree,
		]);
		if (!worktree.ok) throw new Error(`恢复工作区树失败：${formatGitFailure(worktree)}`);
		const index = await runCheckpointGitAsync(checkpoint.repositoryRoot, [
			"read-tree",
			"--reset",
			checkpoint.indexTree,
		]);
		if (!index.ok) throw new Error(`恢复暂存区树失败：${formatGitFailure(index)}`);
		const verifiedIndex = await runCheckpointGitAsync(checkpoint.repositoryRoot, ["write-tree"]);
		if (!verifiedIndex.ok || verifiedIndex.stdout !== checkpoint.indexTree)
			throw new Error("恢复后的暂存区与 checkpoint 不一致。");

		const previousStatus = checkpoint.status;
		checkpoint.status = "restored";
		try {
			updateCheckpointMetadata(checkpoint);
		} catch (metadataError) {
			// Keep the in-memory object retryable when the final metadata write
			// fails; the caller can then record the recovery failure explicitly.
			checkpoint.status = previousStatus;
			throw metadataError;
		}
		return {
			ok: true,
			checkpoint,
			// 任务执行过不透明 Bash：本地 restore 无法验证或撤销其可能产生的远端/外部副作用。
			externalSideEffectsUnknown: checkpoint.hadBashExecution === true,
		};
	} catch (error) {
		// 失败补偿：尽量把 refs/HEAD 回滚到恢复前状态；checkpoint 保持 created，
		// 用户可再次触发 restore（restore 从 checkpoint tree 恢复，是可重试的）。
		const rollbackErrors: string[] = [];
		for (const rollback of [
			() => restoreCheckpointRefs(checkpoint.repositoryRoot, previousRefs),
			() => removeCheckpointNewRefs(checkpoint.repositoryRoot, previousRefs),
			() => restoreGitHeadState(checkpoint.repositoryRoot, previousHead),
		]) {
			try {
				const rollbackResult = await rollback();
				if (rollbackResult) rollbackErrors.push(rollbackResult);
			} catch (rollback) {
				rollbackErrors.push(rollback instanceof Error ? rollback.message : String(rollback));
			}
		}
		const rollbackError = rollbackErrors.join("\n");
		const rollbackNote = rollbackError
			? `；回滚 refs/HEAD 时出错：${rollbackError}`
			: "；已回滚 refs/HEAD 到恢复前状态，可重试 restore";
		return {
			ok: false,
			checkpoint,
			error: `${error instanceof Error ? error.message : String(error)}${rollbackNote}`,
		};
	}
}

export async function restoreGitCheckpoint(checkpoint: GitCheckpoint): Promise<GitCheckpointRestoreResult> {
	if (checkpoint.status !== "created") {
		return { ok: false, checkpoint, error: `检查点当前状态为 ${checkpoint.status}，不能恢复。` };
	}
	try {
		resolveStoragePath(checkpoint.repositoryRoot, checkpoint.storagePath);
	} catch (error) {
		return {
			ok: false,
			checkpoint,
			error: `检查点存储路径无效，拒绝恢复：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (checkpoint.version >= CHECKPOINT_VERSION && checkpoint.worktreeTree && checkpoint.indexTree) {
		return restoreTreeCheckpoint(checkpoint);
	}

	return {
		ok: false,
		checkpoint,
		error: "旧版 checkpoint 缺少 Git tree 基线，不能由当前状态恢复。",
	};
}

export function deleteGitCheckpoint(checkpoint: GitCheckpoint): GitCheckpointDeleteResult {
	try {
		resolveStoragePath(checkpoint.repositoryRoot, checkpoint.storagePath);
	} catch (error) {
		return {
			ok: false,
			error: `检查点存储路径无效，拒绝删除：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		checkpoint.status = "deleted";
		updateCheckpointMetadata(checkpoint);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const referenceError = deleteCheckpointReferences(checkpoint.repositoryRoot, checkpoint);
	if (referenceError) {
		return {
			ok: false,
			cleanupError: `检查点已标记为 deleted，但清理 Git 私有引用失败：${referenceError}`,
		};
	}

	try {
		rmSync(checkpoint.storagePath, { recursive: true, force: false });
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			cleanupError: `检查点已标记为 deleted，但清理目录失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function cleanupGitCheckpoints(options: {
	storageRoot?: string;
	sessionId?: string;
	now?: () => Date;
	ttlMs?: number;
	resolvedTtlMs?: number;
}): GitCheckpointCleanupResult {
	const configuredStorageRoot = resolve(options.storageRoot ?? join(getAgentDir(), "checkpoints"));
	let storageRoot: string;
	try {
		// Resolve once to reject dangling links, but keep the configured lexical
		// path so metadata paths remain stable for a valid external link.
		resolvePhysicalPath(configuredStorageRoot);
		storageRoot = configuredStorageRoot;
	} catch {
		return { removed: 0, failed: [configuredStorageRoot] };
	}
	const nowMs = (options.now ?? (() => new Date()))().getTime();
	const ttlMs = options.ttlMs ?? CHECKPOINT_TTL_MS;
	const resolvedTtlMs = options.resolvedTtlMs ?? RESOLVED_CHECKPOINT_TTL_MS;
	const failed: string[] = [];
	let removed = 0;
	const sessionNames = options.sessionId ? [sanitizeSegment(options.sessionId)] : safeDirectoryNames(storageRoot);

	for (const sessionName of sessionNames) {
		const sessionPath = join(storageRoot, sessionName);
		if (!existsSync(sessionPath)) continue;
		for (const checkpointName of safeDirectoryNames(sessionPath)) {
			const checkpointPath = join(sessionPath, checkpointName);
			if (!checkpointName.startsWith("checkpoint-")) continue;
			try {
				const checkpoint = readMetadata(checkpointPath);
				const age = Math.max(0, nowMs - new Date(checkpoint.createdAt).getTime());
				const limit = checkpoint.status === "created" ? ttlMs : resolvedTtlMs;
				if (age < limit) continue;
				// 与 deleteGitCheckpoint 一致：worktree 和 index 两个 hidden ref 都要删，
				// 否则 index tree 对象残留、Git GC 无法回收。
				const referenceError = deleteCheckpointReferences(checkpoint.repositoryRoot, checkpoint);
				if (referenceError) throw new Error(referenceError);
				rmSync(checkpointPath, { recursive: true, force: false });
				removed++;
			} catch {
				failed.push(checkpointPath);
			}
		}
	}
	return { removed, failed };
}

function safeDirectoryNames(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}
