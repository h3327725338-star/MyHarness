import { resolve } from "node:path";
import {
	beginRepositoryDirectoryMove,
	deleteLocalGitRepositoryMetadata,
	getMovedRepositoryPath,
	getRenamedRepositoryPath,
	initializeManagedLocalGitRepository,
	inspectLocalGitRepositoryPath,
	type LocalGitRepository,
	type LocalGitRepositoryStore,
	localGitRepositoryPathsEqual,
	selectLocalGitRepository,
	validateRepositoryDirectoryMove,
} from "../../git/local-repositories/store.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import type { WorkspaceStore } from "../workspace-store.ts";

export type { LocalGitRepository } from "../../git/local-repositories/store.ts";
export { LocalGitRepositoryStore } from "../../git/local-repositories/store.ts";

export interface LocalGitRepositoryActionResult {
	ok: boolean;
	error?: string;
	message?: string;
	requiresInitialization?: boolean;
	rootPath?: string;
	/** The running session moved with the repository; the management view should close. */
	close?: boolean;
}

/** Steps the host runs around switching the running session to the relocated directory. */
export interface SessionWorkspaceRelocationSteps {
	beforeCommit: () => void;
	rollbackBeforeCommit: () => void;
	moveDirectory: () => Promise<void>;
	rollbackDirectoryMove: () => void;
}

export interface LocalGitRepositoryHost {
	getCurrentCwd(): string;
	/** Why the repository the running session works in cannot be changed right now, if it cannot. */
	getMutationBlocker(repositoryRoot: string): string | undefined;
	/** The repository of the running session changed; refresh what is shown about it. */
	refreshGitState(): void;
	/** Stop watching the repository directory so it can be moved. */
	pauseGitStateWatching(): void;
	/** Move the running session to its new working directory. */
	relocateSessionWorkspace(
		cwd: string,
		steps: SessionWorkspaceRelocationSteps,
	): Promise<{ cancelled: boolean; warnings: string[] }>;
	notify(message: string): void;
}

/**
 * Management of the locally registered Git repositories: add, initialize,
 * remove `.git`, rename and move. Renaming or moving the repository of the
 * running session also moves the session, its Workspace record and the
 * repository record together, and rolls all of them back on failure.
 */
export class LocalGitRepositoryUseCase {
	private readonly store: LocalGitRepositoryStore;
	private readonly workspaceStore: WorkspaceStore;
	private readonly host: LocalGitRepositoryHost;

	constructor(store: LocalGitRepositoryStore, workspaceStore: WorkspaceStore, host: LocalGitRepositoryHost) {
		this.store = store;
		this.workspaceStore = workspaceStore;
		this.host = host;
	}

	list(): LocalGitRepository[] {
		return this.store.list();
	}

	isUsedByCurrentSession(repositoryRoot: string): boolean {
		return getCwdRelativePath(this.host.getCurrentCwd(), repositoryRoot) !== undefined;
	}

	async add(pathInput: string, initialize: boolean): Promise<LocalGitRepositoryActionResult> {
		const result = selectLocalGitRepository(this.store, pathInput, this.host.getCurrentCwd(), initialize);
		if (!result.ok) {
			return {
				ok: false,
				error: result.error,
				requiresInitialization: result.requiresInitialization,
				rootPath: result.rootPath,
			};
		}
		if (result.repository && this.isUsedByCurrentSession(result.repository.rootPath)) {
			this.host.refreshGitState();
		}
		return {
			ok: true,
			rootPath: result.repository?.rootPath,
			message: initialize ? "Git 仓库已初始化并添加。" : "本地 Git 仓库已添加。",
		};
	}

	async initialize(repository: LocalGitRepository): Promise<LocalGitRepositoryActionResult> {
		const blocked = this.host.getMutationBlocker(repository.rootPath);
		if (blocked) return { ok: false, error: blocked };
		const result = initializeManagedLocalGitRepository(repository.rootPath);
		if (!result.ok) return result;
		if (this.isUsedByCurrentSession(repository.rootPath)) this.host.refreshGitState();
		return { ok: true, rootPath: repository.rootPath, message: "Git 仓库已初始化。" };
	}

	async delete(repository: LocalGitRepository): Promise<LocalGitRepositoryActionResult> {
		const blocked = this.host.getMutationBlocker(repository.rootPath);
		if (blocked) return { ok: false, error: blocked };
		const current = this.isUsedByCurrentSession(repository.rootPath);
		const deleted = deleteLocalGitRepositoryMetadata(repository.rootPath);
		if (!deleted.ok) return { ok: false, error: deleted.error };
		const removed = this.store.remove(repository.id);
		if (!removed.ok) {
			return {
				ok: false,
				error: deleted.removed
					? `已删除 .git，但无法更新本地仓库列表：${removed.error ?? "未知错误"}`
					: removed.error,
			};
		}
		if (current) this.host.refreshGitState();
		return {
			ok: true,
			message: deleted.removed ? "已删除 .git，项目文件和文件夹保持不变。" : "该仓库已不存在，记录已移除。",
		};
	}

	async rename(repository: LocalGitRepository, name: string): Promise<LocalGitRepositoryActionResult> {
		const destination = getRenamedRepositoryPath(repository.rootPath, name);
		if (!destination.rootPath) return { ok: false, error: destination.error };
		return this.relocate(repository, destination.rootPath, "renamed");
	}

	async move(repository: LocalGitRepository, destinationParent: string): Promise<LocalGitRepositoryActionResult> {
		const destination = getMovedRepositoryPath(repository.rootPath, destinationParent, this.host.getCurrentCwd());
		if (!destination.rootPath) return { ok: false, error: destination.error };
		return this.relocate(repository, destination.rootPath, "moved");
	}

	async relocate(
		repository: LocalGitRepository,
		destinationRoot: string,
		operation: "renamed" | "moved",
	): Promise<LocalGitRepositoryActionResult> {
		const status = inspectLocalGitRepositoryPath(repository.rootPath);
		if (status.kind === "missing") return { ok: false, error: `仓库目录不存在：${repository.rootPath}` };
		if (status.kind === "error") return { ok: false, error: status.error };
		if (status.kind !== "repository" || !localGitRepositoryPathsEqual(status.rootPath, repository.rootPath)) {
			return { ok: false, error: "所选目录不再是独立的 Git 仓库。" };
		}
		const blocked = this.host.getMutationBlocker(repository.rootPath);
		if (blocked) return { ok: false, error: blocked };

		const currentCwd = this.host.getCurrentCwd();
		const currentRelativePath = getCwdRelativePath(currentCwd, repository.rootPath);
		let moveTransaction: ReturnType<typeof beginRepositoryDirectoryMove> | undefined;
		let directoryMoveRolledBack = false;
		const rollbackDirectoryMove = (): void => {
			if (!moveTransaction || directoryMoveRolledBack) return;
			moveTransaction.rollback();
			directoryMoveRolledBack = true;
		};
		try {
			if (currentRelativePath !== undefined) {
				// Check collisions before closing cwd-bound services. The actual move
				// happens after their teardown to release Windows file handles.
				validateRepositoryDirectoryMove(repository.rootPath, destinationRoot);
			} else {
				moveTransaction = beginRepositoryDirectoryMove(repository.rootPath, destinationRoot);
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		let workspaceMetadataMoved = false;
		let repositoryMetadataMoved = false;
		const rollbackMetadata = (): void => {
			const errors: string[] = [];
			if (repositoryMetadataMoved) {
				const repositoryAtDestination = this.store.getByRootPath(destinationRoot);
				const repositoryRollback = repositoryAtDestination
					? this.store.updateLocation(repositoryAtDestination.id, repository.rootPath)
					: { ok: false, error: "找不到移动后的本地仓库记录。" };
				if (repositoryRollback.ok) repositoryMetadataMoved = false;
				else errors.push(repositoryRollback.error ?? "本地仓库路径回滚失败。");
			}
			if (workspaceMetadataMoved) {
				const workspaceRollback = this.workspaceStore.relocateUnderRoot(destinationRoot, repository.rootPath);
				if (workspaceRollback.ok) workspaceMetadataMoved = false;
				else errors.push(workspaceRollback.error ?? "Workspace 路径回滚失败。");
			}
			if (errors.length > 0) throw new Error(errors.join("；"));
		};
		const commitMetadata = (): void => {
			const workspaceResult = this.workspaceStore.relocateUnderRoot(repository.rootPath, destinationRoot);
			if (!workspaceResult.ok) throw new Error(workspaceResult.error ?? "更新 Workspace 路径失败。");
			workspaceMetadataMoved = (workspaceResult.workspaces?.length ?? 0) > 0;

			const repositoryResult = this.store.updateLocation(repository.id, destinationRoot);
			if (repositoryResult.ok) {
				repositoryMetadataMoved = true;
				return;
			}

			try {
				rollbackMetadata();
			} catch (rollbackError) {
				throw new Error(
					`${repositoryResult.error ?? "更新本地仓库路径失败。"}；元数据回滚失败：${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
			throw new Error(repositoryResult.error ?? "更新本地仓库路径失败。");
		};
		const hasMetadataChanges = (): boolean => workspaceMetadataMoved || repositoryMetadataMoved;

		try {
			const warnings: string[] = [];
			if (currentRelativePath !== undefined) {
				const relocatedCwd =
					currentRelativePath === "." ? destinationRoot : resolve(destinationRoot, currentRelativePath);
				const relocation = await this.host.relocateSessionWorkspace(relocatedCwd, {
					beforeCommit: commitMetadata,
					rollbackBeforeCommit: rollbackMetadata,
					moveDirectory: async () => {
						this.host.pauseGitStateWatching();
						await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
						moveTransaction = beginRepositoryDirectoryMove(repository.rootPath, destinationRoot);
					},
					rollbackDirectoryMove,
				});
				if (relocation.cancelled) {
					return { ok: false, error: "会话切换已取消，仓库目录保持不变。" };
				}
				warnings.push(...relocation.warnings);
			} else {
				commitMetadata();
			}
			if (!moveTransaction) throw new Error("仓库目录移动未启动。");
			const committedMove = moveTransaction.commit();
			if (committedMove.warning) warnings.push(committedMove.warning);
			const verb = operation === "renamed" ? "重命名" : "移动";
			const message = [`仓库已${verb}：${destinationRoot}`, ...warnings].join("\n");
			if (currentRelativePath !== undefined) this.host.notify(message);
			return { ok: true, rootPath: destinationRoot, message, close: currentRelativePath !== undefined };
		} catch (error) {
			const rollbackErrors: string[] = [];
			if (hasMetadataChanges()) {
				try {
					rollbackMetadata();
				} catch (rollbackError) {
					rollbackErrors.push(
						`元数据回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			try {
				rollbackDirectoryMove();
			} catch (rollbackError) {
				rollbackErrors.push(
					`目录回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
			return {
				ok: false,
				error: [error instanceof Error ? error.message : String(error), ...rollbackErrors].join("\n"),
			};
		}
	}
}
