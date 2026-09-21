import { SessionManager } from "../../session/manager/index.ts";
import { deleteSessionFile } from "../../session/storage/jsonl/file-operations.ts";
import type { SessionInfo } from "../../session/types.ts";
import { getCwdRelativePath, pathIdentityKey } from "../../utils/paths.ts";

export interface WorkspaceSessionUseCaseHost {
	getSessionDir: () => string | undefined;
	getCurrentSessionPath: () => string | undefined;
	isSessionIdle: () => boolean;
	newSession: () => Promise<{ cancelled: boolean }>;
	switchWorkspace: (cwd: string) => Promise<{ cancelled: boolean }>;
}

/** Session and workspace flows used by the workspace management surface. */
export class WorkspaceSessionUseCase {
	private readonly host: WorkspaceSessionUseCaseHost;

	constructor(host: WorkspaceSessionUseCaseHost) {
		this.host = host;
	}

	listSessions(cwd: string): Promise<SessionInfo[]> {
		return SessionManager.list(cwd, this.host.getSessionDir());
	}

	async deleteSession(sessionPath: string): Promise<string | undefined> {
		if (this.isCurrentSession(sessionPath)) {
			const error = await this.replaceCurrentSession();
			if (error) return error;
		}
		const deleted = await deleteSessionFile(sessionPath);
		return deleted.ok ? undefined : (deleted.error ?? "删除会话失败。");
	}

	async clearSessions(rootPath: string): Promise<string | undefined> {
		const sessions = await this.listSessions(rootPath);
		const activeFile = this.host.getCurrentSessionPath();
		const activeIncluded =
			activeFile !== undefined &&
			sessions.some((session) => pathIdentityKey(session.path) === pathIdentityKey(activeFile));
		if (activeIncluded) {
			const error = await this.replaceCurrentSession();
			if (error) return error;
		}
		for (const session of sessions) {
			const deleted = await deleteSessionFile(session.path);
			if (!deleted.ok) return deleted.error ?? "删除会话失败。";
		}
		return undefined;
	}

	async createSessionInWorkspace(rootPath: string, currentCwd: string): Promise<string | undefined> {
		try {
			const result =
				getCwdRelativePath(rootPath, currentCwd) === "."
					? await this.host.newSession()
					: await this.host.switchWorkspace(rootPath);
			return result.cancelled ? "已取消。" : undefined;
		} catch (error) {
			return `创建 Chat 失败：${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private isCurrentSession(sessionPath: string): boolean {
		const current = this.host.getCurrentSessionPath();
		return current !== undefined && pathIdentityKey(sessionPath) === pathIdentityKey(current);
	}

	private async replaceCurrentSession(): Promise<string | undefined> {
		if (!this.host.isSessionIdle()) return "不能删除正在运行的会话。";
		const result = await this.host.newSession();
		return result.cancelled ? "已取消。" : undefined;
	}
}
