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
	inspectLocalGitRepositoryPath,
	type LocalGitRepository,
	type LocalGitRepositoryStatus,
} from "../../../git/local-repositories/store.ts";
import { getCwdRelativePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";

export interface LocalGitRepositoryActionResult {
	ok: boolean;
	error?: string;
	message?: string;
	requiresInitialization?: boolean;
	rootPath?: string;
	close?: boolean;
}

export interface LocalGitRepositorySidebarOptions {
	ui: TUI;
	currentCwd: string;
	getRepositories: () => LocalGitRepository[];
	onAdd: (path: string, initialize: boolean) => Promise<LocalGitRepositoryActionResult>;
	onInitialize: (repository: LocalGitRepository) => Promise<LocalGitRepositoryActionResult>;
	onDelete: (repository: LocalGitRepository) => Promise<LocalGitRepositoryActionResult>;
	onRename: (repository: LocalGitRepository, name: string) => Promise<LocalGitRepositoryActionResult>;
	onMove: (repository: LocalGitRepository, destinationParent: string) => Promise<LocalGitRepositoryActionResult>;
	onWorktrees?: (repository: LocalGitRepository) => void;
	onClose: () => void;
}

type RepositoryView = {
	repository: LocalGitRepository;
	status: LocalGitRepositoryStatus;
};

type SidebarRow =
	| { kind: "add" }
	| { kind: "separator" }
	| { kind: "empty" }
	| { kind: "repository"; view: RepositoryView };

type DialogMode = "add" | "rename" | "move";

function fitLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "", true);
}

function shortenPath(pathText: string): string {
	const home = os.homedir();
	return pathText.startsWith(home) ? `~${pathText.slice(home.length)}` : pathText;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class RepositoryInputDialog implements Component, Focusable {
	private readonly options: {
		ui: TUI;
		mode: DialogMode;
		initialValue?: string;
		onSubmit: (value: string, initialize: boolean) => Promise<LocalGitRepositoryActionResult>;
		onCompleted: (result: LocalGitRepositoryActionResult) => void;
		onCancel: () => void;
	};
	private readonly input = new Input();
	private status: { kind: "error" | "info"; text: string } | undefined;
	private pendingInitializationInput: string | undefined;
	private submitting = false;
	private _focused = false;

	constructor(options: {
		ui: TUI;
		mode: DialogMode;
		initialValue?: string;
		onSubmit: (value: string, initialize: boolean) => Promise<LocalGitRepositoryActionResult>;
		onCompleted: (result: LocalGitRepositoryActionResult) => void;
		onCancel: () => void;
	}) {
		this.options = options;
		if (options.initialValue) this.input.setValue(options.initialValue);
		this.input.onSubmit = (value) => void this.submit(value);
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
		if (this.submitting) return;
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		this.input.handleInput(data);
		this.options.ui.requestRender();
	}

	render(width: number): string[] {
		const bodyWidth = Math.max(1, width - 4);
		const titleText =
			this.options.mode === "add"
				? " Add / Initialize Repository "
				: this.options.mode === "rename"
					? " Rename Repository Folder "
					: " Move Repository Folder ";
		const label =
			this.options.mode === "rename"
				? "New folder name"
				: this.options.mode === "move"
					? "Destination folder"
					: "Path";
		const top = `┌${titleText}${"─".repeat(Math.max(0, width - visibleWidth(titleText) - 2))}┐`;
		const bottom = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		const body = (text: string) => `│ ${fitLine(text, bodyWidth)} │`;
		const feedback = this.submitting
			? theme.fg("accent", "Working…")
			: this.status
				? theme.fg(this.status.kind === "error" ? "error" : "muted", this.status.text)
				: "";
		return [
			fitLine(theme.fg("border", top), width),
			body(theme.fg("text", label)),
			body(this.input.render(bodyWidth)[0] ?? ""),
			body(feedback),
			body(theme.fg("muted", "Enter Confirm · Esc Cancel")),
			fitLine(theme.fg("border", bottom), width),
		];
	}

	private async submit(value: string): Promise<void> {
		if (this.submitting) return;
		const initialize = this.options.mode === "add" && this.pendingInitializationInput === value;
		this.submitting = true;
		this.status = undefined;
		this.options.ui.requestRender();
		let result: LocalGitRepositoryActionResult;
		try {
			result = await this.options.onSubmit(value, initialize);
		} catch (error) {
			result = { ok: false, error: formatError(error) };
		}
		this.submitting = false;
		if (result.ok) {
			this.options.onCompleted(result);
			return;
		}
		if (result.requiresInitialization) {
			this.pendingInitializationInput = value;
			this.status = { kind: "info", text: "该目录不是 Git 仓库。再次按 Enter 初始化。" };
		} else {
			this.pendingInitializationInput = undefined;
			this.status = { kind: "error", text: result.error ?? "操作失败。" };
		}
		this.options.ui.requestRender();
	}
}

/** Full-screen local repository manager opened by `/git`. */
export class LocalGitRepositorySidebarComponent implements Component, Focusable {
	private readonly options: LocalGitRepositorySidebarOptions;
	private repositories: RepositoryView[] = [];
	private rows: SidebarRow[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private statusMessage: { kind: "error" | "info"; text: string } | undefined;
	private dialogHandle: OverlayHandle | undefined;
	private confirmDeleteId: string | undefined;
	private busy = false;
	private _focused = false;

	constructor(options: LocalGitRepositorySidebarOptions) {
		this.options = options;
		this.refresh();
		const currentIndex = this.rows.findIndex(
			(row) => row.kind === "repository" && this.isCurrentRepository(row.view.repository),
		);
		if (currentIndex >= 0) this.selectedIndex = currentIndex;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}
	invalidate(): void {}

	private refresh(preferredRootPath?: string): void {
		this.repositories = this.options.getRepositories().map((repository) => ({
			repository,
			status: inspectLocalGitRepositoryPath(repository.rootPath),
		}));
		this.rows = [
			{ kind: "add" },
			{ kind: "separator" },
			...(this.repositories.length === 0
				? ([{ kind: "empty" }] as SidebarRow[])
				: this.repositories.map((view): SidebarRow => ({ kind: "repository", view }))),
		];
		if (preferredRootPath) {
			const index = this.rows.findIndex(
				(row) => row.kind === "repository" && row.view.repository.rootPath === preferredRootPath,
			);
			if (index >= 0) this.selectedIndex = index;
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
		while (this.selectedIndex > 0 && !this.isSelectable(this.rows[this.selectedIndex])) this.selectedIndex--;
	}

	private isSelectable(row: SidebarRow | undefined): boolean {
		return row?.kind === "add" || row?.kind === "repository";
	}

	private isCurrentRepository(repository: LocalGitRepository): boolean {
		return getCwdRelativePath(this.options.currentCwd, repository.rootPath) !== undefined;
	}

	private selectedRepository(): LocalGitRepository | undefined {
		const row = this.rows[this.selectedIndex];
		return row?.kind === "repository" ? row.view.repository : undefined;
	}

	private setStatus(kind: "error" | "info", text: string): void {
		this.statusMessage = { kind, text };
		this.options.ui.requestRender();
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
			this.options.ui.requestRender();
		}
	}

	private openDialog(mode: DialogMode, repository?: LocalGitRepository): void {
		if (this.dialogHandle || this.busy) return;
		let handle: OverlayHandle | undefined;
		const close = () => {
			handle?.hide();
			this.dialogHandle = undefined;
			this.options.ui.requestRender();
		};
		const dialog = new RepositoryInputDialog({
			ui: this.options.ui,
			mode,
			initialValue: mode === "rename" ? repository?.name : undefined,
			onSubmit: (value, initialize) => {
				if (mode === "add") return this.options.onAdd(value, initialize);
				if (!repository) return Promise.resolve({ ok: false, error: "请先选择仓库。" });
				return mode === "rename"
					? this.options.onRename(repository, value)
					: this.options.onMove(repository, value);
			},
			onCompleted: (result) => {
				close();
				if (result.close) {
					this.options.onClose();
					return;
				}
				this.refresh(result.rootPath);
				this.setStatus("info", result.message ?? "操作完成。");
			},
			onCancel: close,
		});
		handle = this.options.ui.showOverlay(dialog, {
			width: "60%",
			minWidth: 36,
			maxWidth: 72,
			anchor: "center",
		});
		this.dialogHandle = handle;
	}

	private async initializeSelected(): Promise<void> {
		const repository = this.selectedRepository();
		if (!repository || this.busy) return;
		this.busy = true;
		this.setStatus("info", "正在初始化 Git 仓库…");
		try {
			const result = await this.options.onInitialize(repository);
			if (!result.ok) {
				this.setStatus("error", result.error ?? "初始化 Git 仓库失败。");
				return;
			}
			this.refresh(repository.rootPath);
			this.setStatus("info", result.message ?? "Git 仓库已初始化。");
		} catch (error) {
			this.setStatus("error", formatError(error));
		} finally {
			this.busy = false;
		}
	}

	private async deleteSelected(): Promise<void> {
		const repository = this.selectedRepository();
		if (!repository || repository.id !== this.confirmDeleteId || this.busy) return;
		this.confirmDeleteId = undefined;
		this.busy = true;
		this.setStatus("info", "正在删除 .git…");
		try {
			const result = await this.options.onDelete(repository);
			if (!result.ok) {
				this.setStatus("error", result.error ?? "删除 Git 仓库失败。");
				return;
			}
			this.refresh();
			this.setStatus("info", result.message ?? "已删除 .git，项目文件保持不变。");
		} catch (error) {
			this.setStatus("error", formatError(error));
		} finally {
			this.busy = false;
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.busy) return;
		if (this.confirmDeleteId) {
			if (kb.matches(data, "tui.select.confirm")) void this.deleteSelected();
			else if (kb.matches(data, "tui.select.cancel")) {
				this.confirmDeleteId = undefined;
				this.options.ui.requestRender();
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

		const repository = this.selectedRepository();
		if (matchesKey(data, "a")) {
			this.openDialog("add");
			return;
		}
		if (matchesKey(data, "i")) {
			void this.initializeSelected();
			return;
		}
		if (matchesKey(data, "d") && repository) {
			this.confirmDeleteId = repository.id;
			this.options.ui.requestRender();
			return;
		}
		if (matchesKey(data, "r") && repository) {
			this.openDialog("rename", repository);
			return;
		}
		if (matchesKey(data, "m") && repository) {
			this.openDialog("move", repository);
			return;
		}
		if (matchesKey(data, "w") && repository) {
			this.options.onWorktrees?.(repository);
		}
		if (kb.matches(data, "tui.select.confirm") && this.rows[this.selectedIndex]?.kind === "add") {
			this.openDialog("add");
		}
	}

	render(width: number): string[] {
		const termHeight = Math.max(1, this.options.ui.getTerminalSize().rows);
		const contentWidth = Math.max(0, width - 1);
		const header = [
			theme.fg(this._focused ? "accent" : "text", theme.bold("Git · Local repositories")),
			theme.fg("dim", "Repositories are added only from folders you choose."),
			"",
		];
		const helpLines = this.helpLines(contentWidth);
		const viewportHeight = Math.max(1, termHeight - header.length - helpLines.length - 1);
		this.ensureSelectionVisible(viewportHeight);
		const endIndex = Math.min(this.scrollOffset + viewportHeight, this.rows.length);
		const listLines: string[] = [];
		for (let index = this.scrollOffset; index < endIndex; index++) {
			listLines.push(this.renderRow(this.rows[index]!, index === this.selectedIndex && this._focused, contentWidth));
		}
		while (listLines.length < viewportHeight) listLines.push("");
		const info = this.confirmDeleteId
			? theme.fg("error", "Delete only this repository's .git? Enter confirm · Esc cancel")
			: this.statusMessage
				? theme.fg(this.statusMessage.kind === "error" ? "error" : "muted", this.statusMessage.text)
				: "";
		const lines = [...header, ...listLines, truncateToWidth(info, contentWidth, "…"), ...helpLines];
		while (lines.length < termHeight) lines.push("");
		const dividerColor = this._focused ? "accent" : "border";
		return lines.slice(0, termHeight).map((line) => `${fitLine(line, contentWidth)}${theme.fg(dividerColor, "│")}`);
	}

	private ensureSelectionVisible(viewportHeight: number): void {
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		if (this.selectedIndex >= this.scrollOffset + viewportHeight) {
			this.scrollOffset = this.selectedIndex - viewportHeight + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.rows.length - viewportHeight)));
	}

	private renderRow(row: SidebarRow, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		if (row.kind === "separator") return "";
		if (row.kind === "empty") return theme.fg("muted", "  No local repositories · A to add");
		if (row.kind === "add") {
			const text = "+ Add / Initialize Repository";
			return `${cursor}${theme.fg(selected ? "accent" : "text", selected ? theme.bold(text) : text)}`;
		}

		const { repository, status } = row.view;
		const current = this.isCurrentRepository(repository);
		const currentMark = current ? theme.fg("accent", "● ") : "  ";
		const statusText =
			status.kind === "repository"
				? "Git"
				: status.kind === "directory"
					? "not initialized"
					: status.kind === "missing"
						? "missing"
						: "unavailable";
		const pending = this.confirmDeleteId === repository.id ? theme.fg("error", " !") : "";
		const prefix = `${cursor}${currentMark}`;
		const suffix = ` · ${statusText}${pending}`;
		const nameWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const rawName = truncateToWidth(repository.name, nameWidth, "…");
		let name = theme.fg(current ? "accent" : "text", rawName);
		if (selected) name = theme.bold(name);
		return `${prefix}${name}${theme.fg(status.kind === "missing" || status.kind === "error" ? "error" : "muted", suffix)}`;
	}

	private helpLines(width: number): string[] {
		const repository = this.selectedRepository();
		const pathLine = repository ? theme.fg("dim", truncateToWidth(shortenPath(repository.rootPath), width, "…")) : "";
		const labels = [
			"↑↓/Pg Move",
			"A Add",
			"I Initialize",
			"D Delete .git",
			"R Rename",
			"M Move",
			"W Worktrees",
			"Esc Close",
		];
		const lines: string[] = [];
		let current = "";
		for (const label of labels) {
			const candidate = current ? `${current} · ${label}` : label;
			if (!current || visibleWidth(candidate) <= width) current = candidate;
			else {
				lines.push(theme.fg("muted", truncateToWidth(current, width, "…")));
				current = label;
			}
		}
		if (current) lines.push(theme.fg("muted", truncateToWidth(current, width, "…")));
		return [pathLine, ...lines];
	}
}
