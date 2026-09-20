import * as os from "node:os";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@myharness/tui";
import {
	type ConversationBatchRenameProgress,
	type ConversationBatchRenameSummary,
	type ConversationTitleResult,
	normalizeConversationTitle,
	validateConversationTitle,
} from "../../../agent/runtime/conversation-title.ts";
import type { Workspace, WorkspaceStore } from "../../../application/workspace-store.ts";
import type { SessionInfo } from "../../../session/types.ts";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";

export interface WorkspaceSidebarOptions {
	ui: TUI;
	store: WorkspaceStore;
	currentCwd: string;
	currentSessionPath?: string;
	getCurrentSessionPath?: () => string | undefined;
	listSessions: (cwd: string) => Promise<SessionInfo[]>;
	onOpenSession: (sessionPath: string) => void;
	onNewSessionInWorkspace: (rootPath: string) => Promise<string | undefined>;
	/** Delete a persisted session file. Returns an error message, or undefined on success. */
	deleteSession?: (sessionPath: string) => Promise<string | undefined>;
	/** Delete all persisted session files of a workspace. Returns an error message, or undefined on success. */
	clearSessions?: (rootPath: string) => Promise<string | undefined>;
	/** Generate and persist an AI title for one chat. */
	onRenameSession?: (sessionPath: string, signal?: AbortSignal) => Promise<ConversationTitleResult>;
	/** Persist a user-provided title for one chat. */
	onRenameSessionManually?: (sessionPath: string, title: string) => Promise<void>;
	/** Generate and persist AI titles for all chats in one workspace. */
	onRenameAllSessions?: (
		rootPath: string,
		signal: AbortSignal,
		onProgress: (progress: ConversationBatchRenameProgress) => void,
	) => Promise<ConversationBatchRenameSummary>;
	initialExpandedIds?: Iterable<string>;
	onExpandedIdsChange?: (ids: ReadonlySet<string>) => void;
	onClose: () => void;
}

type SidebarRow =
	| { kind: "new-chat" }
	| { kind: "add-workspace" }
	| { kind: "separator" }
	| { kind: "empty-workspaces" }
	| { kind: "workspace"; workspace: Workspace; expanded: boolean }
	| { kind: "chat-loading"; workspace: Workspace }
	| { kind: "chat"; workspace: Workspace; session: SessionInfo; isLast: boolean }
	| { kind: "workspace-new-chat"; workspace: Workspace };

type ManualRenameTarget = {
	workspaceId: string;
	sessionPath: string;
	currentTitle: string;
};

function shortenPath(pathText: string): string {
	const home = os.homedir();
	return pathText.startsWith(home) ? `~${pathText.slice(home.length)}` : pathText;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(pathText: string | undefined): string | undefined {
	if (!pathText) return pathText;
	try {
		return _canonicalizePath(pathText);
	} catch {
		return pathText;
	}
}

function normalizeTitle(text: string): string {
	return (
		text
			.replace(/[\x00-\x1f\x7f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim() || "Untitled chat"
	);
}

function fitLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "", true);
}

/** Focus-capturing modal used instead of turning the sidebar body into a path editor. */
class AddWorkspaceDialog implements Component, Focusable {
	private readonly options: {
		ui: TUI;
		store: WorkspaceStore;
		currentCwd: string;
		onAdded: (workspace: Workspace) => void;
		onCancel: () => void;
	};
	private readonly input = new Input();
	private statusMessage: string | undefined;
	private _focused = false;

	constructor(options: {
		ui: TUI;
		store: WorkspaceStore;
		currentCwd: string;
		onAdded: (workspace: Workspace) => void;
		onCancel: () => void;
	}) {
		this.options = options;
		this.input.onSubmit = (value) => this.submit(value);
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}
	invalidate(): void {}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		const bodyWidth = Math.max(1, width - 4);
		const title = " Add Workspace ";
		const top = `┌${title}${"─".repeat(Math.max(0, width - visibleWidth(title) - 2))}┐`;
		const bottom = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		const body = (text: string) => `│ ${fitLine(text, bodyWidth)} │`;
		const inputLine = this.input.render(bodyWidth)[0] ?? "";
		return [
			fitLine(theme.fg("border", top), width),
			body(theme.fg("text", "Path")),
			body(inputLine),
			body(this.statusMessage ? theme.fg("error", this.statusMessage) : ""),
			body(theme.fg("muted", "Enter Add · Esc Cancel")),
			fitLine(theme.fg("border", bottom), width),
		];
	}

	private submit(value: string): void {
		const result = this.options.store.add(value, this.options.currentCwd);
		if (!result.ok || !result.workspace) {
			this.statusMessage = result.error ?? "添加 Workspace 失败。";
			this.options.ui.requestRender();
			return;
		}
		this.options.onAdded(result.workspace);
	}
}

/** Workspace / Chat tree sidebar opened by `/workspace`. */
export class WorkspaceSidebarComponent implements Component, Focusable {
	private readonly options: WorkspaceSidebarOptions;
	private workspaces: Workspace[];
	private readonly expandedIds: Set<string>;
	private readonly sessionsByWorkspace = new Map<string, SessionInfo[] | null>();
	private readonly loadSeqByWorkspace = new Map<string, number>();
	private rows: SidebarRow[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private statusMessage: { kind: "error" | "info"; text: string } | undefined;
	private addDialogHandle: OverlayHandle | undefined;
	private confirmDeletePath: string | undefined;
	private confirmDeleteWorkspaceId: string | undefined;
	private batchDeleteMode = false;
	private batchDeleteWorkspaceId: string | undefined;
	private readonly selectedSessionPaths = new Set<string>();
	private batchDeleteConfirming = false;
	private batchDeleteEntering = false;
	private batchDeleteSubmitting = false;
	private batchDeleteProgress: { processed: number; total: number } | undefined;
	private renameMode: "single" | "batch" | undefined;
	private renameAbortController: AbortController | undefined;
	private renameProgress: ConversationBatchRenameProgress | undefined;
	private manualRenameTarget: ManualRenameTarget | undefined;
	private manualRenameError: string | undefined;
	private manualRenameSubmitting = false;
	private readonly manualRenameInput = new Input();
	private _focused = false;

	constructor(options: WorkspaceSidebarOptions) {
		this.options = options;
		this.manualRenameInput.onSubmit = (value) => {
			void this.submitManualRename(value);
		};
		this.workspaces = options.store.list();
		this.expandedIds = new Set(options.initialExpandedIds ?? [...this.workspaces.map((workspace) => workspace.id)]);
		const currentWorkspace = options.store.getByPath(options.currentCwd);
		if (currentWorkspace) this.expandedIds.add(currentWorkspace.id);
		for (const workspace of this.workspaces) {
			if (this.expandedIds.has(workspace.id)) this.sessionsByWorkspace.set(workspace.id, null);
		}
		this.rebuildRows();
		if (currentWorkspace) this.selectRow(`workspace:${currentWorkspace.id}`);
		else if (this.workspaces.length === 0) this.selectRow("add-workspace");
		for (const workspace of this.workspaces) {
			if (this.expandedIds.has(workspace.id)) void this.loadSessions(workspace);
		}
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.manualRenameInput.focused = value && this.manualRenameTarget !== undefined;
	}
	invalidate(): void {}

	private rowKey(row: SidebarRow | undefined): string | undefined {
		if (!row) return undefined;
		switch (row.kind) {
			case "new-chat":
			case "add-workspace":
			case "separator":
			case "empty-workspaces":
				return row.kind;
			case "workspace":
				return `workspace:${row.workspace.id}`;
			case "chat-loading":
				return `loading:${row.workspace.id}`;
			case "chat":
				return `chat:${row.session.path}`;
			case "workspace-new-chat":
				return `workspace-new-chat:${row.workspace.id}`;
		}
	}

	private isSelectable(row: SidebarRow | undefined): boolean {
		return (
			row?.kind === "new-chat" ||
			row?.kind === "add-workspace" ||
			row?.kind === "workspace" ||
			row?.kind === "chat" ||
			row?.kind === "workspace-new-chat"
		);
	}

	private rebuildRows(preferredKey = this.rowKey(this.rows[this.selectedIndex])): void {
		const rows: SidebarRow[] = [{ kind: "new-chat" }, { kind: "add-workspace" }, { kind: "separator" }];
		if (this.workspaces.length === 0) rows.push({ kind: "empty-workspaces" });
		for (const workspace of this.workspaces) {
			const expanded = this.expandedIds.has(workspace.id);
			rows.push({ kind: "workspace", workspace, expanded });
			if (!expanded) continue;
			const sessions = this.sessionsByWorkspace.get(workspace.id);
			if (sessions === undefined || sessions === null) {
				rows.push({ kind: "chat-loading", workspace });
			} else if (sessions.length === 0) {
				rows.push({ kind: "workspace-new-chat", workspace });
			} else {
				for (let i = 0; i < sessions.length; i++) {
					rows.push({ kind: "chat", workspace, session: sessions[i]!, isLast: i === sessions.length - 1 });
				}
			}
		}
		this.rows = rows;
		const preservedIndex = preferredKey ? rows.findIndex((row) => this.rowKey(row) === preferredKey) : -1;
		if (preservedIndex >= 0 && this.isSelectable(rows[preservedIndex])) {
			this.selectedIndex = preservedIndex;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, rows.length - 1));
			while (this.selectedIndex > 0 && !this.isSelectable(rows[this.selectedIndex])) this.selectedIndex--;
		}
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, rows.length - 1));
	}

	private selectRow(key: string): void {
		const index = this.rows.findIndex((row) => this.rowKey(row) === key);
		if (index >= 0 && this.isSelectable(this.rows[index])) this.selectedIndex = index;
	}
	private requestRender(): void {
		this.options.ui.requestRender();
	}

	private async loadSessions(workspace: Workspace): Promise<boolean> {
		const seq = (this.loadSeqByWorkspace.get(workspace.id) ?? 0) + 1;
		this.loadSeqByWorkspace.set(workspace.id, seq);
		const previousSessions = this.sessionsByWorkspace.get(workspace.id);
		this.sessionsByWorkspace.set(workspace.id, null);
		try {
			const sessions = await this.options.listSessions(workspace.rootPath);
			if (this.loadSeqByWorkspace.get(workspace.id) !== seq) return false;
			this.sessionsByWorkspace.set(workspace.id, sessions);
			this.rebuildRows();
			this.requestRender();
			return true;
		} catch {
			if (this.loadSeqByWorkspace.get(workspace.id) !== seq) return false;
			// A refresh failure must not erase a list that was already visible.
			this.sessionsByWorkspace.set(workspace.id, previousSessions ?? []);
			this.rebuildRows();
			this.requestRender();
			return false;
		}
	}

	private notifyExpandedIdsChange(): void {
		this.options.onExpandedIdsChange?.(new Set(this.expandedIds));
	}
	private toggleWorkspace(workspace: Workspace): void {
		if (this.expandedIds.has(workspace.id)) {
			this.expandedIds.delete(workspace.id);
			this.sessionsByWorkspace.delete(workspace.id);
			this.loadSeqByWorkspace.delete(workspace.id);
		} else {
			this.expandedIds.add(workspace.id);
			this.loadSessions(workspace);
		}
		this.rebuildRows(`workspace:${workspace.id}`);
		this.notifyExpandedIdsChange();
		this.requestRender();
	}

	private targetWorkspaceForNewChat(): Workspace | undefined {
		const row = this.rows[this.selectedIndex];
		if (row?.kind === "workspace" || row?.kind === "chat" || row?.kind === "workspace-new-chat") return row.workspace;
		return this.options.store.getByPath(this.options.currentCwd);
	}
	private targetWorkspaceForRename(): Workspace | undefined {
		const row = this.rows[this.selectedIndex];
		if (row?.kind === "workspace" || row?.kind === "chat" || row?.kind === "workspace-new-chat") return row.workspace;
		return undefined;
	}
	private targetWorkspaceForBatchDelete(): Workspace | undefined {
		const row = this.rows[this.selectedIndex];
		if (row?.kind === "workspace" || row?.kind === "chat" || row?.kind === "workspace-new-chat") return row.workspace;
		return this.options.store.getByPath(this.options.currentCwd);
	}

	private getBatchDeleteWorkspace(): Workspace | undefined {
		if (!this.batchDeleteWorkspaceId) return undefined;
		return this.workspaces.find((workspace) => workspace.id === this.batchDeleteWorkspaceId);
	}

	private sessionSelectionKey(sessionPath: string): string {
		return canonicalizePath(sessionPath) ?? sessionPath;
	}

	private isBatchDeleteTarget(row: SidebarRow): row is Extract<SidebarRow, { kind: "chat" }> {
		return row.kind === "chat" && row.workspace.id === this.batchDeleteWorkspaceId;
	}

	private getBatchDeleteSessions(): SessionInfo[] {
		const workspace = this.getBatchDeleteWorkspace();
		if (!workspace) return [];
		return this.sessionsByWorkspace.get(workspace.id) ?? [];
	}

	private getCurrentSessionPath(): string | undefined {
		return this.options.getCurrentSessionPath
			? this.options.getCurrentSessionPath()
			: this.options.currentSessionPath;
	}

	private async enterBatchDeleteMode(): Promise<void> {
		if (this.batchDeleteMode || this.batchDeleteEntering || this.batchDeleteSubmitting) return;
		if (!this.options.deleteSession) {
			this.setStatus("error", "Batch Delete 功能不可用。");
			return;
		}

		const workspace = this.targetWorkspaceForBatchDelete();
		if (!workspace) {
			this.setStatus("error", "请先选择一个 Workspace。");
			return;
		}

		this.batchDeleteEntering = true;
		try {
			if (!this.expandedIds.has(workspace.id)) {
				this.expandedIds.add(workspace.id);
				this.notifyExpandedIdsChange();
			}
			let sessions = this.sessionsByWorkspace.get(workspace.id);
			if (sessions === undefined || sessions === null) {
				this.setStatus("info", `Loading chats for batch delete…`);
				await this.loadSessions(workspace);
				sessions = this.sessionsByWorkspace.get(workspace.id);
			}
			if (!sessions || sessions.length === 0) {
				this.setStatus("error", `Workspace ${workspace.name} has no chats to delete.`);
				return;
			}

			this.batchDeleteWorkspaceId = workspace.id;
			this.batchDeleteMode = true;
			this.batchDeleteConfirming = false;
			this.selectedSessionPaths.clear();
			this.statusMessage = undefined;
			this.rebuildRows();
		} finally {
			this.batchDeleteEntering = false;
			this.requestRender();
		}
	}

	private exitBatchDeleteMode(): void {
		this.batchDeleteMode = false;
		this.batchDeleteWorkspaceId = undefined;
		this.selectedSessionPaths.clear();
		this.batchDeleteConfirming = false;
		this.batchDeleteProgress = undefined;
	}

	private cancelBatchDelete(): void {
		this.exitBatchDeleteMode();
		this.setStatus("info", "Batch Delete cancelled.");
	}

	private toggleBatchDeleteSelection(): void {
		const row = this.rows[this.selectedIndex];
		if (!row || !this.isBatchDeleteTarget(row)) return;
		this.statusMessage = undefined;
		const key = this.sessionSelectionKey(row.session.path);
		if (this.selectedSessionPaths.has(key)) this.selectedSessionPaths.delete(key);
		else this.selectedSessionPaths.add(key);
		this.requestRender();
	}

	private selectAllBatchDeleteSessions(): void {
		const sessions = this.getBatchDeleteSessions();
		if (sessions.length === 0) {
			this.setStatus("error", "No chats are available for batch deletion.");
			return;
		}
		this.statusMessage = undefined;
		this.selectedSessionPaths.clear();
		for (const session of sessions) this.selectedSessionPaths.add(this.sessionSelectionKey(session.path));
		this.requestRender();
	}

	private clearBatchDeleteSelection(): void {
		this.statusMessage = undefined;
		this.selectedSessionPaths.clear();
		this.batchDeleteConfirming = false;
		this.requestRender();
	}

	private async deleteSelectedBatchSessions(): Promise<void> {
		if (!this.batchDeleteMode || this.batchDeleteSubmitting) return;
		const workspace = this.getBatchDeleteWorkspace();
		const deleteSession = this.options.deleteSession;
		if (!workspace || !deleteSession) {
			this.setStatus("error", "Batch Delete 功能不可用。");
			return;
		}

		const sessions = this.getBatchDeleteSessions();
		const selectedSessions = sessions.filter((session) =>
			this.selectedSessionPaths.has(this.sessionSelectionKey(session.path)),
		);
		if (selectedSessions.length === 0) {
			this.setStatus("error", "Select at least one chat before deleting.");
			return;
		}

		this.batchDeleteConfirming = false;
		this.batchDeleteSubmitting = true;
		this.batchDeleteProgress = { processed: 0, total: selectedSessions.length };
		this.setStatus("info", "Deleting selected sessions…");

		const deletedKeys = new Set<string>();
		const failures: Array<{ path: string; error: string }> = [];
		try {
			for (const session of selectedSessions) {
				try {
					const errorMessage = await deleteSession(session.path);
					if (errorMessage === undefined) deletedKeys.add(this.sessionSelectionKey(session.path));
					else failures.push({ path: session.path, error: errorMessage });
				} catch (error) {
					failures.push({ path: session.path, error: this.formatError(error) });
				} finally {
					this.batchDeleteProgress = {
						processed: (this.batchDeleteProgress?.processed ?? 0) + 1,
						total: selectedSessions.length,
					};
					this.requestRender();
				}
			}

			const currentSessions = this.sessionsByWorkspace.get(workspace.id);
			if (currentSessions) {
				this.sessionsByWorkspace.set(
					workspace.id,
					currentSessions.filter((session) => !deletedKeys.has(this.sessionSelectionKey(session.path))),
				);
			}
			const refreshed = await this.loadSessions(workspace);

			if (failures.length === 0) {
				const deletedCount = deletedKeys.size;
				this.exitBatchDeleteMode();
				this.setStatus(
					"info",
					`Deleted ${deletedCount} selected session${deletedCount === 1 ? "" : "s"}.${
						refreshed ? "" : " Session list refresh failed."
					}`,
				);
				return;
			}

			this.selectedSessionPaths.clear();
			for (const failure of failures) this.selectedSessionPaths.add(this.sessionSelectionKey(failure.path));
			const firstFailure = failures[0]?.error;
			const failureSummary = firstFailure
				? `${failures.length} failed: ${firstFailure}`
				: `${failures.length} failed`;
			this.setStatus(
				"error",
				`Deleted ${deletedKeys.size} of ${selectedSessions.length} sessions. ${failureSummary}.${
					refreshed ? "" : " Refresh failed."
				}`,
			);
			this.rebuildRows();
		} catch (error) {
			this.setStatus("error", `Batch Delete failed: ${this.formatError(error)}`);
		} finally {
			this.batchDeleteSubmitting = false;
			this.batchDeleteProgress = undefined;
			this.requestRender();
		}
	}

	private handleBatchDeleteInput(data: string): void {
		const kb = getKeybindings();
		if (this.batchDeleteSubmitting) return;
		if (this.batchDeleteConfirming) {
			if (kb.matches(data, "tui.select.confirm")) void this.deleteSelectedBatchSessions();
			else if (kb.matches(data, "tui.select.cancel")) {
				this.batchDeleteConfirming = false;
				this.requestRender();
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancelBatchDelete();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-1, 10);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(1, 10);
			return;
		}
		if (matchesKey(data, "space")) {
			this.toggleBatchDeleteSelection();
			return;
		}
		if (matchesKey(data, "a")) {
			this.selectAllBatchDeleteSessions();
			return;
		}
		if (matchesKey(data, "c")) {
			this.clearBatchDeleteSelection();
			return;
		}
		if (matchesKey(data, "d")) {
			if (this.selectedSessionPaths.size === 0) {
				this.setStatus("error", "Select at least one chat before deleting.");
				return;
			}
			this.batchDeleteConfirming = true;
			this.requestRender();
		}
	}
	private setStatus(kind: "error" | "info", text: string): void {
		this.statusMessage = { kind, text };
		this.requestRender();
	}

	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private isConfirmingDelete(): boolean {
		return this.confirmDeletePath !== undefined || this.confirmDeleteWorkspaceId !== undefined;
	}

	private async deleteSelectedChat(): Promise<void> {
		const row = this.rows[this.selectedIndex];
		if (row?.kind !== "chat") return;
		const sessionPath = row.session.path;
		this.confirmDeletePath = undefined;
		this.setStatus("info", "Deleting chat…");
		if (!this.options.deleteSession) {
			this.setStatus("error", "删除 Chat 功能不可用。");
			return;
		}
		let errorMessage: string | undefined;
		try {
			errorMessage = await this.options.deleteSession(sessionPath);
		} catch (error) {
			errorMessage = this.formatError(error);
		}
		if (errorMessage !== undefined) {
			this.setStatus("error", errorMessage);
			return;
		}
		const sessions = this.sessionsByWorkspace.get(row.workspace.id);
		if (sessions) {
			this.sessionsByWorkspace.set(
				row.workspace.id,
				sessions.filter((session) => session.path !== sessionPath),
			);
		}
		this.setStatus("info", "Chat deleted.");
		this.rebuildRows();
		this.requestRender();
	}

	/**
	 * Delete the selected workspace: remove its bound chat session files (the
	 * same program-internal session store used by listSessions), then remove
	 * the workspace record from the persisted list. The real directory is
	 * never touched.
	 */
	private async deleteSelectedWorkspace(): Promise<void> {
		const row = this.rows[this.selectedIndex];
		if (row?.kind !== "workspace") return;
		const workspace = row.workspace;
		this.confirmDeleteWorkspaceId = undefined;
		this.setStatus("info", "Deleting workspace…");
		if (!this.options.clearSessions) {
			this.setStatus("error", "删除 Workspace 功能不可用。");
			return;
		}
		let errorMessage: string | undefined;
		try {
			errorMessage = await this.options.clearSessions(workspace.rootPath);
		} catch (error) {
			errorMessage = this.formatError(error);
		}
		if (errorMessage !== undefined) {
			this.setStatus("error", errorMessage);
			return;
		}
		if (!this.options.store.remove(workspace.id)) {
			this.setStatus("error", "删除 Workspace 失败。");
			return;
		}
		this.workspaces = this.options.store.list();
		this.sessionsByWorkspace.delete(workspace.id);
		this.expandedIds.delete(workspace.id);
		this.loadSeqByWorkspace.delete(workspace.id);
		this.setStatus("info", "Workspace deleted.");
		this.rebuildRows();
		this.notifyExpandedIdsChange();
		this.requestRender();
	}

	private updateSessionTitle(workspaceId: string, sessionPath: string, title: string): void {
		const sessions = this.sessionsByWorkspace.get(workspaceId);
		if (sessions === undefined) return;
		if (sessions === null) {
			const workspace = this.workspaces.find((item) => item.id === workspaceId);
			if (workspace) void this.loadSessions(workspace);
			return;
		}
		this.sessionsByWorkspace.set(
			workspaceId,
			sessions.map((session) => (session.path === sessionPath ? { ...session, name: title } : session)),
		);
		// Rows hold SessionInfo snapshots. Rebuild them so the selected row and its
		// visible title are updated together; the stable path keeps selection intact.
		this.rebuildRows(`chat:${sessionPath}`);
	}

	private startManualRename(): void {
		const row = this.rows[this.selectedIndex];
		if (row?.kind !== "chat") return;
		if (!this.options.onRenameSessionManually) {
			this.setStatus("error", "Manual Rename 功能不可用。");
			return;
		}
		if (this.renameMode || this.manualRenameTarget) return;

		this.manualRenameTarget = {
			workspaceId: row.workspace.id,
			sessionPath: row.session.path,
			currentTitle: normalizeTitle(row.session.name ?? row.session.firstMessage),
		};
		this.manualRenameError = undefined;
		this.manualRenameSubmitting = false;
		// Keep the new-name field blank. The current title is shown separately so
		// users do not have to erase a long generated title first.
		this.manualRenameInput.setValue("");
		this.manualRenameInput.focused = this._focused;
		this.requestRender();
	}

	private exitManualRenameMode(): void {
		this.manualRenameInput.focused = false;
		this.manualRenameTarget = undefined;
		this.manualRenameError = undefined;
		this.manualRenameSubmitting = false;
	}

	private cancelManualRename(): void {
		this.exitManualRenameMode();
		this.setStatus("info", "Manual Rename cancelled.");
	}

	private async submitManualRename(value: string): Promise<void> {
		const target = this.manualRenameTarget;
		const renameSession = this.options.onRenameSessionManually;
		if (!target || !renameSession || this.manualRenameSubmitting) return;

		const title = normalizeConversationTitle(value);
		const validationError = validateConversationTitle(title);
		if (validationError) {
			this.manualRenameError = validationError;
			this.requestRender();
			return;
		}
		this.manualRenameSubmitting = true;
		this.manualRenameError = undefined;
		this.requestRender();
		try {
			await renameSession(target.sessionPath, title);
			this.updateSessionTitle(target.workspaceId, target.sessionPath, title);
			this.exitManualRenameMode();
			this.setStatus("info", `Conversation renamed: ${title}`);
		} catch (error) {
			this.manualRenameSubmitting = false;
			this.manualRenameError = `Manual Rename failed: ${this.formatError(error)}`;
			this.requestRender();
		}
	}

	private async renameSelectedChat(): Promise<void> {
		const row = this.rows[this.selectedIndex];
		if (row?.kind !== "chat") return;
		if (!this.options.onRenameSession) {
			this.setStatus("error", "AI Rename 功能不可用。");
			return;
		}
		if (this.renameMode) return;

		const controller = new AbortController();
		this.renameMode = "single";
		this.renameAbortController = controller;
		this.renameProgress = undefined;
		this.setStatus("info", "AI Rename Chat… Esc Cancel");
		try {
			const result = await this.options.onRenameSession(row.session.path, controller.signal);
			if (result.status === "skipped") {
				this.setStatus("info", `AI Rename skipped: ${result.reason}`);
			} else {
				this.updateSessionTitle(row.workspace.id, row.session.path, result.title);
				this.setStatus(
					"info",
					result.usedFallback ? `AI Rename fallback: ${result.title}` : `AI Rename complete: ${result.title}`,
				);
			}
		} catch (error) {
			const message = controller.signal.aborted
				? "AI Rename cancelled."
				: `AI Rename failed: ${this.formatError(error)}`;
			this.setStatus(controller.signal.aborted ? "info" : "error", message);
		} finally {
			if (this.renameAbortController === controller) this.renameAbortController = undefined;
			this.renameMode = undefined;
			this.renameProgress = undefined;
			this.requestRender();
		}
	}

	private async renameWorkspaceChats(workspace: Workspace): Promise<void> {
		if (!this.options.onRenameAllSessions) {
			this.setStatus("error", "Batch AI Rename 功能不可用。");
			return;
		}
		if (this.renameMode) return;

		const controller = new AbortController();
		this.renameMode = "batch";
		this.renameAbortController = controller;
		this.renameProgress = { total: 0, processed: 0, renamed: 0, skipped: 0, failed: 0, cancelled: 0 };
		this.setStatus("info", `Batch AI Rename · ${workspace.name}`);
		try {
			const summary = await this.options.onRenameAllSessions(workspace.rootPath, controller.signal, (progress) => {
				this.renameProgress = progress;
				this.requestRender();
			});
			const refreshed = await this.loadSessions(workspace);
			this.setStatus(
				refreshed ? "info" : "error",
				`${this.formatBatchRenameSummary(summary)}${refreshed ? "" : " · session list refresh failed"}`,
			);
		} catch (error) {
			this.setStatus("error", `Batch AI Rename failed: ${this.formatError(error)}`);
		} finally {
			if (this.renameAbortController === controller) this.renameAbortController = undefined;
			this.renameMode = undefined;
			this.renameProgress = undefined;
			this.requestRender();
		}
	}

	private formatBatchRenameSummary(summary: ConversationBatchRenameSummary): string {
		const state = summary.cancelledByUser ? "Batch AI Rename cancelled" : "Batch AI Rename complete";
		const pending = summary.remaining > 0 ? ` · pending ${summary.remaining}` : "";
		return `${state}: ${summary.renamed} renamed · ${summary.skipped} skipped · ${summary.failed} failed · ${summary.cancelled} cancelled${pending}`;
	}

	private async createNewChat(workspace = this.targetWorkspaceForNewChat()): Promise<void> {
		if (!workspace) {
			this.setStatus("error", "请先添加 Workspace，再创建 Chat。");
			return;
		}
		this.setStatus("info", "Creating chat…");
		const error = await this.options.onNewSessionInWorkspace(workspace.rootPath);
		if (error !== undefined) this.setStatus("error", error);
	}

	private openAddWorkspaceDialog(): void {
		if (this.addDialogHandle) return;
		let handle: OverlayHandle | undefined;
		const close = () => {
			handle?.hide();
			this.addDialogHandle = undefined;
			this.requestRender();
		};
		const dialog = new AddWorkspaceDialog({
			ui: this.options.ui,
			store: this.options.store,
			currentCwd: this.options.currentCwd,
			onAdded: (workspace) => {
				close();
				this.workspaces = this.options.store.list();
				this.expandedIds.add(workspace.id);
				this.sessionsByWorkspace.set(workspace.id, null);
				this.rebuildRows(`workspace:${workspace.id}`);
				this.loadSessions(workspace);
				this.notifyExpandedIdsChange();
			},
			onCancel: close,
		});
		handle = this.options.ui.showOverlay(dialog, {
			width: "60%",
			minWidth: 32,
			maxWidth: 64,
			anchor: "center",
		});
		this.addDialogHandle = handle;
	}

	private moveSelection(direction: -1 | 1, count = 1): void {
		let index = this.selectedIndex;
		for (let moved = 0; moved < count; moved++) {
			let next = index + direction;
			while (next >= 0 && next < this.rows.length && !this.isSelectable(this.rows[next])) next += direction;
			if (next < 0 || next >= this.rows.length) break;
			index = next;
		}
		if (index !== this.selectedIndex) {
			this.selectedIndex = index;
			this.requestRender();
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.manualRenameTarget) {
			if (kb.matches(data, "tui.select.cancel")) {
				if (!this.manualRenameSubmitting) this.cancelManualRename();
				return;
			}
			if (!this.manualRenameSubmitting) {
				this.manualRenameInput.handleInput(data);
				this.requestRender();
			}
			return;
		}
		if (this.renameMode) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.renameAbortController?.abort(new Error("AI Rename cancelled by user."));
				this.setStatus("info", "Cancelling AI Rename…");
			}
			return;
		}
		if (this.batchDeleteEntering) return;
		if (this.batchDeleteMode) {
			this.handleBatchDeleteInput(data);
			return;
		}
		if (this.isConfirmingDelete()) {
			if (kb.matches(data, "tui.select.confirm")) {
				if (this.confirmDeletePath !== undefined) void this.deleteSelectedChat();
				else if (this.confirmDeleteWorkspaceId !== undefined) void this.deleteSelectedWorkspace();
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.confirmDeletePath = undefined;
				this.confirmDeleteWorkspaceId = undefined;
				this.requestRender();
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-1, 10);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(1, 10);
			return;
		}

		const row = this.rows[this.selectedIndex];
		if (matchesKey(data, "right")) {
			if (row?.kind === "workspace" && !row.expanded) this.toggleWorkspace(row.workspace);
			return;
		}
		if (matchesKey(data, "left")) {
			if (row?.kind === "workspace" && row.expanded) this.toggleWorkspace(row.workspace);
			else if (row?.kind === "chat" || row?.kind === "workspace-new-chat") {
				this.selectRow(`workspace:${row.workspace.id}`);
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, "x")) {
			void this.enterBatchDeleteMode();
			return;
		}
		if (matchesKey(data, "n")) {
			void this.createNewChat();
			return;
		}
		if (matchesKey(data, "a")) {
			this.openAddWorkspaceDialog();
			return;
		}
		if (matchesKey(data, "d")) {
			if (row?.kind === "chat") {
				this.confirmDeletePath = row.session.path;
				this.requestRender();
			} else if (row?.kind === "workspace") {
				this.confirmDeleteWorkspaceId = row.workspace.id;
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, "r")) {
			if (row?.kind === "chat") void this.renameSelectedChat();
			return;
		}
		if (matchesKey(data, "m")) {
			if (row?.kind === "chat") this.startManualRename();
			return;
		}
		if (matchesKey(data, "b")) {
			const workspace = this.targetWorkspaceForRename();
			if (workspace) void this.renameWorkspaceChats(workspace);
			return;
		}

		if (!kb.matches(data, "tui.select.confirm")) return;
		if (row?.kind === "new-chat") void this.createNewChat();
		else if (row?.kind === "add-workspace") this.openAddWorkspaceDialog();
		else if (row?.kind === "workspace") this.toggleWorkspace(row.workspace);
		else if (row?.kind === "chat") {
			this.setStatus("info", "Loading chat…");
			this.options.onOpenSession(row.session.path);
		} else if (row?.kind === "workspace-new-chat") void this.createNewChat(row.workspace);
	}

	render(width: number): string[] {
		const termHeight = Math.max(1, this.options.ui.getTerminalSize().rows);
		const contentWidth = Math.max(0, width - 1);
		const currentWorkspace = this.options.store.getByPath(this.options.currentCwd);
		const header = [
			theme.fg(this._focused ? "accent" : "text", theme.bold("Workspaces")),
			theme.fg("text", `Current · ${currentWorkspace?.name ?? "Untracked directory"}`),
			theme.fg("dim", truncateToWidth(shortenPath(this.options.currentCwd), contentWidth, "…")),
			"",
		];
		const helpLines = this.manualRenameTarget ? this.manualRenameLines(contentWidth) : this.helpLines(contentWidth);
		const viewportHeight = Math.max(1, termHeight - header.length - 1 - helpLines.length);
		this.ensureSelectionVisible(viewportHeight);
		const endIndex = Math.min(this.scrollOffset + viewportHeight, this.rows.length);
		const listLines: string[] = [];
		for (let i = this.scrollOffset; i < endIndex; i++) {
			listLines.push(this.renderRow(this.rows[i]!, i === this.selectedIndex && this._focused, contentWidth));
		}
		while (listLines.length < viewportHeight) listLines.push("");
		const infoLine = this.manualRenameTarget ? "" : this.renderInfoLine(endIndex, contentWidth);
		const lines = [...header, ...listLines, infoLine, ...helpLines];
		while (lines.length < termHeight) lines.push("");
		const dividerColor = this._focused ? "accent" : "border";
		return lines.slice(0, termHeight).map((line) => `${fitLine(line, contentWidth)}${theme.fg(dividerColor, "│")}`);
	}

	private ensureSelectionVisible(viewportHeight: number): void {
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		if (this.selectedIndex >= this.scrollOffset + viewportHeight)
			this.scrollOffset = this.selectedIndex - viewportHeight + 1;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.rows.length - viewportHeight)));
	}
	private renderInfoLine(endIndex: number, width: number): string {
		if (this.batchDeleteSubmitting) {
			const progress = this.batchDeleteProgress;
			const progressText = progress ? ` ${progress.processed}/${progress.total}` : "";
			return theme.fg("accent", truncateToWidth(`Deleting selected sessions…${progressText}`, width, "…"));
		}
		if (this.batchDeleteConfirming) {
			const count = this.selectedSessionPaths.size;
			return theme.fg(
				"error",
				truncateToWidth(
					`Delete ${count} selected session${count === 1 ? "" : "s"}? No Workspace undo.`,
					width,
					"…",
				),
			);
		}
		if (this.batchDeleteMode) {
			if (this.statusMessage) {
				const color = this.statusMessage.kind === "error" ? "error" : "muted";
				return theme.fg(color, truncateToWidth(this.statusMessage.text, width, "…"));
			}
			const workspace = this.getBatchDeleteWorkspace();
			return theme.fg(
				"accent",
				truncateToWidth(
					`Batch Delete · Selected: ${this.selectedSessionPaths.size} sessions · ${workspace?.name ?? "Workspace"}`,
					width,
					"…",
				),
			);
		}
		if (this.renameMode === "batch" && this.renameProgress) {
			const progress = this.renameProgress;
			return theme.fg(
				"accent",
				truncateToWidth(
					`Batch AI Rename ${progress.processed}/${progress.total} · ${progress.renamed} renamed · ${progress.skipped} skipped · ${progress.failed} failed · Esc Cancel`,
					width,
					"…",
				),
			);
		}
		if (this.renameMode === "single") {
			return theme.fg("accent", truncateToWidth("AI Rename Chat… · Esc Cancel", width, "…"));
		}
		if (this.confirmDeletePath !== undefined) {
			return theme.fg("error", truncateToWidth("Delete this chat? Enter confirm · Esc cancel", width, "…"));
		}
		if (this.confirmDeleteWorkspaceId !== undefined) {
			return theme.fg(
				"error",
				truncateToWidth("Delete this workspace and its chat history? Enter confirm · Esc cancel", width, "…"),
			);
		}
		if (this.statusMessage) {
			const color = this.statusMessage.kind === "error" ? "error" : "muted";
			return theme.fg(color, truncateToWidth(this.statusMessage.text, width, "…"));
		}
		if (this.scrollOffset > 0 || endIndex < this.rows.length) {
			const first = Math.min(this.rows.length, this.scrollOffset + 1);
			return theme.fg("muted", truncateToWidth(`↑ ${first}–${endIndex} / ${this.rows.length} ↓`, width, ""));
		}
		return "";
	}

	private renderRow(row: SidebarRow, isSelected: boolean, width: number): string {
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		if (row.kind === "separator") return "";
		if (row.kind === "empty-workspaces")
			return theme.fg("muted", truncateToWidth("  No workspaces · A to add", width, "…"));
		if (row.kind === "new-chat" || row.kind === "add-workspace") {
			const label = row.kind === "new-chat" ? "+ New Chat" : "+ Add Workspace";
			const text = truncateToWidth(label, Math.max(0, width - visibleWidth(cursor)), "…");
			return `${cursor}${theme.fg(isSelected ? "accent" : "text", isSelected ? theme.bold(text) : text)}`;
		}
		if (row.kind === "workspace") {
			const pendingMark = this.confirmDeleteWorkspaceId === row.workspace.id ? theme.fg("error", " !") : "";
			const isCurrent = this.options.store.getByPath(this.options.currentCwd)?.id === row.workspace.id;
			const disclosure = theme.fg(isCurrent ? "accent" : "muted", row.expanded ? "▾" : "▸");
			const currentMark = isCurrent ? theme.fg("accent", "● ") : "  ";
			const prefix = `${cursor}${disclosure} ${currentMark}`;
			const rawName = truncateToWidth(
				`${row.workspace.name}${pendingMark}`,
				Math.max(0, width - visibleWidth(prefix)),
				"…",
			);
			let name = theme.fg(isCurrent ? "accent" : "text", rawName);
			if (isSelected) name = theme.bold(name);
			return `${prefix}${name}`;
		}
		if (row.kind === "chat-loading") return theme.fg("muted", truncateToWidth("    └─ Loading chats…", width, "…"));
		if (row.kind === "workspace-new-chat") {
			const prefix = `${cursor}  └─ `;
			const label = truncateToWidth("+ New Chat", Math.max(0, width - visibleWidth(prefix)), "…");
			return `${theme.fg("dim", prefix)}${theme.fg(isSelected ? "accent" : "muted", label)}`;
		}

		const isCurrentChat = canonicalizePath(row.session.path) === canonicalizePath(this.getCurrentSessionPath());
		const branch = row.isLast ? "└─" : "├─";
		const pendingMark = this.confirmDeletePath === row.session.path ? theme.fg("error", " !") : "";
		const selectionMark = this.isBatchDeleteTarget(row)
			? this.selectedSessionPaths.has(this.sessionSelectionKey(row.session.path))
				? "[x] "
				: "[ ] "
			: "";
		const currentMark = isCurrentChat ? theme.fg("accent", "● ") : "  ";
		const prefix = `${cursor} ${selectionMark}${theme.fg("dim", branch)} ${currentMark}`;
		let age = formatSessionDate(row.session.modified);
		if (width - visibleWidth(prefix) - visibleWidth(age) - 1 < 6) age = "";
		const gap = age ? 1 : 0;
		const titleWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(age) - gap);
		const displayText = normalizeTitle(row.session.name ?? row.session.firstMessage);
		const truncatedTitle = truncateToWidth(`${displayText}${pendingMark}`, titleWidth, "…");
		let title = theme.fg(isCurrentChat ? "accent" : "text", truncatedTitle);
		if (isSelected) title = theme.bold(title);
		const left = `${prefix}${title}`;
		const spacing = age ? " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(age))) : "";
		return `${left}${spacing}${age ? theme.fg("dim", age) : ""}`;
	}

	private helpLines(width: number): string[] {
		if (this.batchDeleteMode) {
			const labels = this.batchDeleteConfirming
				? ["Enter Confirm", "Esc Cancel"]
				: ["↑↓ Move", "Space Select", "A Select All", "C Clear Selection", "D Delete Selected", "Esc Cancel"];
			return [theme.fg("muted", truncateToWidth(labels.join(" · "), width, "…"))];
		}
		if (this.renameMode) return [theme.fg("muted", truncateToWidth("Esc Cancel", width, "…"))];
		if (width < 40) {
			return [
				"↑↓/Pg Move · Enter Open",
				"←→ Tree · X Batch Delete",
				"N New · A Add · D Delete",
				"R AI Rename · M Manual Rename",
				"B Batch AI Rename · Esc Close",
			].map((line) => theme.fg("muted", truncateToWidth(line, width, "…")));
		}

		const actionLabels = [
			"↑↓/Pg Move",
			"Enter Open/Expand",
			"←→ Tree",
			"X Batch Delete",
			"N New",
			"A Add",
			"D Delete",
			"R AI Rename Chat",
			"M Manual Rename",
			"B Batch AI Rename",
			"Esc Close",
		];
		const lines: string[] = [];
		let current = "";
		for (const label of actionLabels) {
			const candidate = current ? `${current} · ${label}` : label;
			if (!current || visibleWidth(candidate) <= width) {
				current = candidate;
			} else {
				lines.push(theme.fg("muted", truncateToWidth(current, width, "…")));
				current = label;
			}
		}
		if (current) lines.push(theme.fg("muted", truncateToWidth(current, width, "…")));
		return lines;
	}

	private manualRenameLines(width: number): string[] {
		const target = this.manualRenameTarget;
		if (!target) return [];
		const inputLabel = "New name: > ";
		const inputWidth = Math.max(1, width - visibleWidth(inputLabel));
		const inputLine = this.manualRenameInput.render(inputWidth)[0] ?? "";
		const feedback = this.manualRenameSubmitting
			? theme.fg("accent", "Saving…")
			: this.manualRenameError
				? theme.fg("error", this.manualRenameError)
				: theme.fg("muted", "Enter Save · Esc Cancel");
		return [
			theme.fg("accent", theme.bold("Rename conversation")),
			theme.fg("muted", `Current: ${target.currentTitle}`),
			`${theme.fg("text", inputLabel)}${inputLine}`,
			feedback,
		].map((line) => fitLine(line, width));
	}
}
