import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { getCwdRelativePath, pathIdentityKey, resolvePath } from "../../utils/paths.ts";
import { type GitCommandResult, initializeGitRepository, inspectGitRepository } from "../repository/integration.ts";

export interface LocalGitRepository {
	/** Stable identifier. It changes with the repository directory path. */
	id: string;
	name: string;
	rootPath: string;
	createdAt: string;
}

export type LocalGitRepositoryStatus =
	| { kind: "repository"; rootPath: string }
	| { kind: "directory"; rootPath: string }
	| { kind: "missing"; rootPath: string }
	| { kind: "error"; rootPath: string; error: string };

export interface LocalGitRepositoryResult {
	ok: boolean;
	repository?: LocalGitRepository;
	error?: string;
}

export interface SelectLocalGitRepositoryResult extends LocalGitRepositoryResult {
	requiresInitialization?: boolean;
	rootPath?: string;
}

export interface RepositoryDirectoryMoveTransaction {
	readonly sourcePath: string;
	readonly destinationPath: string;
	commit(): { warning?: string };
	rollback(): void;
}

const LOCAL_GIT_REPOSITORIES_FILE_VERSION = 1;

interface LocalGitRepositoriesFile {
	version: number;
	repositories: LocalGitRepository[];
}

export function getLocalGitRepositoriesPath(agentDir: string): string {
	return join(agentDir, "local-git-repositories.json");
}

export function localGitRepositoryPathsEqual(a: string, b: string): boolean {
	return pathIdentityKey(a) === pathIdentityKey(b);
}

function isPathInside(pathToCheck: string, parentPath: string): boolean {
	return getCwdRelativePath(pathToCheck, parentPath) !== undefined;
}

function repositoryName(rootPath: string): string {
	return basename(rootPath) || parse(rootPath).root || rootPath;
}

function isLocalGitRepository(value: unknown): value is LocalGitRepository {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<LocalGitRepository>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.name === "string" &&
		typeof candidate.rootPath === "string" &&
		candidate.rootPath.length > 0 &&
		typeof candidate.createdAt === "string"
	);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatGitFailure(result: GitCommandResult): string {
	return result.error || result.stderr.trim() || result.stdout.trim() || "Git 命令执行失败";
}

export function validateLocalGitDirectory(input: string, baseDir: string): { rootPath: string } | { error: string } {
	const raw = input.trim();
	if (!raw) return { error: "请输入文件夹路径。" };

	let rootPath: string;
	try {
		rootPath = resolvePath(raw, baseDir);
	} catch {
		return { error: `无法解析路径：${raw}` };
	}

	try {
		if (!existsSync(rootPath)) return { error: `目录不存在：${rootPath}` };
		if (!statSync(rootPath).isDirectory()) return { error: `不是目录：${rootPath}` };
		accessSync(rootPath, constants.R_OK);
		return { rootPath };
	} catch (error) {
		return { error: `无法访问目录：${rootPath}（${formatError(error)}）` };
	}
}

/** Inspect one explicitly selected path. This function never scans for repositories. */
export function inspectLocalGitRepositoryPath(rootPath: string): LocalGitRepositoryStatus {
	const resolvedRoot = resolvePath(rootPath);
	try {
		if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
			return { kind: "missing", rootPath: resolvedRoot };
		}
	} catch (error) {
		return { kind: "error", rootPath: resolvedRoot, error: formatError(error) };
	}

	const state = inspectGitRepository(resolvedRoot);
	if (!state.gitAvailable) {
		return { kind: "error", rootPath: resolvedRoot, error: state.error ?? "当前电脑无法使用 Git。" };
	}
	if (!state.isRepository || !state.root) return { kind: "directory", rootPath: resolvedRoot };

	const repositoryRoot = resolvePath(state.root);
	return { kind: "repository", rootPath: repositoryRoot };
}

export class LocalGitRepositoryStore {
	private readonly filePath: string;
	private repositories: LocalGitRepository[];

	private constructor(filePath: string, repositories: LocalGitRepository[]) {
		this.filePath = filePath;
		this.repositories = repositories;
	}

	static create(agentDir: string): LocalGitRepositoryStore {
		const filePath = getLocalGitRepositoriesPath(agentDir);
		let repositories: LocalGitRepository[] = [];
		try {
			if (existsSync(filePath)) {
				const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<LocalGitRepositoriesFile>;
				if (Array.isArray(raw.repositories)) repositories = raw.repositories.filter(isLocalGitRepository);
			}
		} catch {
			// Keep startup usable when the small machine-managed registry is unreadable.
		}
		return new LocalGitRepositoryStore(filePath, repositories);
	}

	list(): LocalGitRepository[] {
		return this.repositories.map((repository) => ({ ...repository }));
	}

	getById(id: string): LocalGitRepository | undefined {
		const repository = this.repositories.find((candidate) => candidate.id === id);
		return repository ? { ...repository } : undefined;
	}

	getByRootPath(rootPath: string): LocalGitRepository | undefined {
		const repository = this.repositories.find((candidate) =>
			localGitRepositoryPathsEqual(candidate.rootPath, rootPath),
		);
		return repository ? { ...repository } : undefined;
	}

	add(rootPath: string): LocalGitRepositoryResult {
		const normalizedRoot = resolvePath(rootPath);
		if (this.repositories.some((candidate) => localGitRepositoryPathsEqual(candidate.rootPath, normalizedRoot))) {
			return { ok: false, error: `本地仓库已添加：${normalizedRoot}` };
		}
		const repository: LocalGitRepository = {
			id: normalizedRoot,
			name: repositoryName(normalizedRoot),
			rootPath: normalizedRoot,
			createdAt: new Date().toISOString(),
		};
		const next = [...this.repositories, repository];
		try {
			this.save(next);
			this.repositories = next;
			return { ok: true, repository: { ...repository } };
		} catch (error) {
			return { ok: false, error: `保存本地仓库列表失败：${formatError(error)}` };
		}
	}

	remove(id: string): LocalGitRepositoryResult {
		const repository = this.repositories.find((candidate) => candidate.id === id);
		if (!repository) return { ok: false, error: "本地仓库记录不存在。" };
		const next = this.repositories.filter((candidate) => candidate.id !== id);
		try {
			this.save(next);
			this.repositories = next;
			return { ok: true, repository: { ...repository } };
		} catch (error) {
			return { ok: false, error: `保存本地仓库列表失败：${formatError(error)}` };
		}
	}

	updateLocation(id: string, rootPath: string): LocalGitRepositoryResult {
		const index = this.repositories.findIndex((candidate) => candidate.id === id);
		if (index === -1) return { ok: false, error: "本地仓库记录不存在。" };
		const normalizedRoot = resolvePath(rootPath);
		if (
			this.repositories.some(
				(candidate, candidateIndex) =>
					candidateIndex !== index && localGitRepositoryPathsEqual(candidate.rootPath, normalizedRoot),
			)
		) {
			return { ok: false, error: `目标仓库已添加：${normalizedRoot}` };
		}
		const repository: LocalGitRepository = {
			...this.repositories[index]!,
			id: normalizedRoot,
			name: repositoryName(normalizedRoot),
			rootPath: normalizedRoot,
		};
		const next = [...this.repositories];
		next[index] = repository;
		try {
			this.save(next);
			this.repositories = next;
			return { ok: true, repository: { ...repository } };
		} catch (error) {
			return { ok: false, error: `保存本地仓库列表失败：${formatError(error)}` };
		}
	}

	private save(repositories: LocalGitRepository[]): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const content = `${JSON.stringify(
			{ version: LOCAL_GIT_REPOSITORIES_FILE_VERSION, repositories } satisfies LocalGitRepositoriesFile,
			null,
			2,
		)}\n`;
		const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx" });
			renameSync(tmpPath, this.filePath);
		} finally {
			if (existsSync(tmpPath)) {
				try {
					unlinkSync(tmpPath);
				} catch {
					// Preserve the write or rename failure.
				}
			}
		}
	}
}

export function selectLocalGitRepository(
	store: LocalGitRepositoryStore,
	input: string,
	baseDir: string,
	initialize: boolean,
): SelectLocalGitRepositoryResult {
	const validation = validateLocalGitDirectory(input, baseDir);
	if ("error" in validation) return { ok: false, error: validation.error };

	let status = inspectLocalGitRepositoryPath(validation.rootPath);
	if (status.kind === "error") return { ok: false, error: `Git：${status.error}` };
	if (status.kind === "missing") return { ok: false, error: `目录不存在：${status.rootPath}` };
	if (status.kind === "directory") {
		if (!initialize) {
			return { ok: false, requiresInitialization: true, rootPath: status.rootPath };
		}
		const initialized = initializeGitRepository(status.rootPath);
		if (!initialized.ok) return { ok: false, error: `初始化 Git 仓库失败：${formatGitFailure(initialized)}` };
		status = inspectLocalGitRepositoryPath(status.rootPath);
		if (status.kind !== "repository") {
			return {
				ok: false,
				error: status.kind === "error" ? `Git：${status.error}` : "Git 初始化完成，但无法确认仓库根目录。",
			};
		}
	}

	const existing = store.getByRootPath(status.rootPath);
	if (existing) return { ok: true, repository: existing };
	return store.add(status.rootPath);
}

export function initializeManagedLocalGitRepository(rootPath: string): { ok: boolean; error?: string } {
	const validation = validateLocalGitDirectory(rootPath, process.cwd());
	if ("error" in validation) return { ok: false, error: validation.error };

	const existing = inspectLocalGitRepositoryPath(validation.rootPath);
	if (existing.kind === "error") return { ok: false, error: `Git：${existing.error}` };
	if (existing.kind === "repository") {
		if (!localGitRepositoryPathsEqual(existing.rootPath, validation.rootPath)) {
			return { ok: false, error: `所选目录属于另一个 Git 仓库：${existing.rootPath}` };
		}
		return { ok: true };
	}
	if (existing.kind === "missing") return { ok: false, error: `目录不存在：${existing.rootPath}` };

	const initialized = initializeGitRepository(validation.rootPath);
	if (!initialized.ok) return { ok: false, error: `初始化 Git 仓库失败：${formatGitFailure(initialized)}` };
	const status = inspectLocalGitRepositoryPath(validation.rootPath);
	if (status.kind !== "repository" || !localGitRepositoryPathsEqual(status.rootPath, validation.rootPath)) {
		return { ok: false, error: "Git 初始化完成，但无法确认所选目录是仓库根目录。" };
	}
	return { ok: true };
}

/** Remove exactly `<repositoryRoot>/.git`; project files and the directory itself are never removed. */
export function deleteLocalGitRepositoryMetadata(rootPath: string): { ok: boolean; removed: boolean; error?: string } {
	const resolvedRoot = resolvePath(rootPath);
	try {
		if (!existsSync(resolvedRoot)) return { ok: true, removed: false };
		if (!statSync(resolvedRoot).isDirectory())
			return { ok: false, removed: false, error: `不是目录：${resolvedRoot}` };
		const gitPath = join(resolvedRoot, ".git");
		if (!existsSync(gitPath)) return { ok: true, removed: false };
		const gitEntry = lstatSync(gitPath);
		if (gitEntry.isDirectory() && !gitEntry.isSymbolicLink()) {
			rmSync(gitPath, { recursive: true, force: false });
		} else {
			unlinkSync(gitPath);
		}
		if (existsSync(gitPath)) return { ok: false, removed: false, error: `未能删除：${gitPath}` };
		return { ok: true, removed: true };
	} catch (error) {
		return { ok: false, removed: false, error: `删除 .git 失败：${formatError(error)}` };
	}
}

export function validateRepositoryFolderName(name: string): string | undefined {
	const normalized = name.trim();
	if (!normalized) return "请输入新的文件夹名称。";
	if (normalized === "." || normalized === "..") return "文件夹名称不能是 . 或 ..。";
	if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
		return "请输入文件夹名称，不要包含路径分隔符。";
	}
	if (process.platform === "win32" && /[<>:"|?*]/.test(normalized)) return "文件夹名称包含 Windows 不允许的字符。";
	return undefined;
}

export function getRenamedRepositoryPath(rootPath: string, name: string): { rootPath?: string; error?: string } {
	const validationError = validateRepositoryFolderName(name);
	if (validationError) return { error: validationError };
	const sourcePath = resolvePath(rootPath);
	if (dirname(sourcePath) === sourcePath) return { error: "不能重命名文件系统根目录。" };
	return { rootPath: join(dirname(sourcePath), name.trim()) };
}

export function getMovedRepositoryPath(
	rootPath: string,
	destinationParent: string,
	baseDir: string = process.cwd(),
): { rootPath?: string; error?: string } {
	const validation = validateLocalGitDirectory(destinationParent, baseDir);
	if ("error" in validation) return { error: validation.error };
	return { rootPath: join(validation.rootPath, basename(resolvePath(rootPath))) };
}

function getRepositoryDirectoryMovePaths(
	sourcePath: string,
	destinationPath: string,
): { source: string; destination: string; destinationParent: string; sameLogicalPath: boolean } {
	const source = resolvePath(sourcePath);
	const destination = resolvePath(destinationPath);
	const sameLogicalPath = localGitRepositoryPathsEqual(source, destination);
	if (source === destination) throw new Error("源路径和目标路径相同。");
	if (!sameLogicalPath && isPathInside(destination, source)) {
		throw new Error("目标路径不能位于仓库目录内。");
	}
	if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`仓库目录不存在：${source}`);
	if (!sameLogicalPath && existsSync(destination)) throw new Error(`目标路径已存在：${destination}`);
	const destinationParent = dirname(destination);
	if (!existsSync(destinationParent) || !statSync(destinationParent).isDirectory()) {
		throw new Error(`目标父目录不存在：${destinationParent}`);
	}
	return { source, destination, destinationParent, sameLogicalPath };
}

/** Validate a directory move without changing the filesystem. */
export function validateRepositoryDirectoryMove(sourcePath: string, destinationPath: string): void {
	getRepositoryDirectoryMovePaths(sourcePath, destinationPath);
}

/**
 * Start a reversible directory move. Same-volume moves use one rename. For an
 * EXDEV move, the source is atomically parked only after a complete temporary
 * copy exists at the destination, so rollback remains possible until commit.
 */
export function beginRepositoryDirectoryMove(
	sourcePath: string,
	destinationPath: string,
): RepositoryDirectoryMoveTransaction {
	const { source, destination, destinationParent, sameLogicalPath } = getRepositoryDirectoryMovePaths(
		sourcePath,
		destinationPath,
	);

	if (sameLogicalPath) {
		// Windows treats case-only paths as the same directory. Park the source
		// briefly so a folder rename such as `repo` -> `Repo` remains reversible.
		const sourceStage = join(dirname(source), `.${basename(source)}.myharness-rename-${randomUUID()}`);
		renameSync(source, sourceStage);
		try {
			renameSync(sourceStage, destination);
		} catch (error) {
			try {
				renameSync(sourceStage, source);
			} catch (rollbackError) {
				throw new Error(`${formatError(error)}；恢复原目录失败：${formatError(rollbackError)}`);
			}
			throw error;
		}

		let finished = false;
		return {
			sourcePath: source,
			destinationPath: destination,
			commit: () => {
				finished = true;
				return {};
			},
			rollback: () => {
				if (finished) throw new Error("目录移动已经提交，不能回滚。");
				renameSync(destination, source);
				finished = true;
			},
		};
	}

	try {
		renameSync(source, destination);
		let finished = false;
		return {
			sourcePath: source,
			destinationPath: destination,
			commit: () => {
				finished = true;
				return {};
			},
			rollback: () => {
				if (finished) throw new Error("目录移动已经提交，不能回滚。");
				renameSync(destination, source);
				finished = true;
			},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
	}

	const token = randomUUID();
	const destinationStage = join(destinationParent, `.${basename(destination)}.myharness-copy-${token}`);
	const sourceStage = join(dirname(source), `.${basename(source)}.myharness-move-${token}`);
	try {
		cpSync(source, destinationStage, {
			recursive: true,
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
			verbatimSymlinks: true,
		});
		renameSync(source, sourceStage);
		try {
			renameSync(destinationStage, destination);
		} catch (error) {
			renameSync(sourceStage, source);
			throw error;
		}
	} catch (error) {
		if (existsSync(destinationStage)) rmSync(destinationStage, { recursive: true, force: true });
		throw error;
	}

	let finished = false;
	return {
		sourcePath: source,
		destinationPath: destination,
		commit: () => {
			if (finished) return {};
			finished = true;
			try {
				rmSync(sourceStage, { recursive: true, force: false });
				return {};
			} catch (error) {
				return { warning: `仓库已移动，但旧位置的临时目录清理失败：${formatError(error)}` };
			}
		},
		rollback: () => {
			if (finished) throw new Error("目录移动已经提交，不能回滚。");
			rmSync(destination, { recursive: true, force: false });
			renameSync(sourceStage, source);
			finished = true;
		},
	};
}
