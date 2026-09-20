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
import type { GitWorktreeUseCaseActionResult } from "../../../application/use-cases/git-worktree.ts";
import type { GitWorktree, GitWorktreeCombineResult } from "../../../git/worktrees/manager.ts";
import { getCwdRelativePath, resolvePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";

export interface GitWorktreeListSnapshot {
	worktrees: GitWorktree[];
	error?: string;
}

export interface GitWorktreeSidebarOptions {
	ui: TUI;
	repositoryRoot: string;
	currentCwd: string;
	getWorktrees: () => GitWorktreeListSnapshot;
	onCreateExisting: (branchName: string) => Promise<GitWorktreeUseCaseActionResult>;
	onCreateBranch: (branchName: string) => Promise<GitWorktreeUseCaseActionResult>;
	onDelete: (worktree: GitWorktree) => Promise<GitWorktreeUseCaseActionResult>;
	onEnter: (worktree: GitWorktree) => Promise<GitWorktreeUseCaseActionResult>;
	onGenerateLauncher: (worktree: GitWorktree) => Promise<GitWorktreeUseCaseActionResult>;
	onCombine: (worktree: GitWorktree) => Promise<GitWorktreeCombineResult>;
	onClose: () => void;
}

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

function pathsEqual(a: string, b: string): boolean {
	const normalizedA = resolvePath(a);
	const normalizedB = resolvePath(b);
	return process.platform === "win32"
		? normalizedA.toLowerCase() === normalizedB.toLowerCase()
		: normalizedA === normalizedB;
}

class BranchInputDialog implements Component, Focusable {
	private readonly options: {
		ui: TUI;
		title: string;
		label: string;
		onSubmit: (branchName: string) => Promise<GitWorktreeUseCaseActionResult>;
		onCompleted: (result: GitWorktreeUseCaseActionResult) => void;
		onCancel: () => void;
	};
	private readonly input = new Input();
	private status: { kind: "error" | "info"; text: string } | undefined;
	private submitting = false;
	private _focused = false;

	constructor(options: {
		ui: TUI;
		title: string;
		label: string;
		onSubmit: (branchName: string) => Promise<GitWorktreeUseCaseActionResult>;
		onCompleted: (result: GitWorktreeUseCaseActionResult) => void;
		onCancel: () => void;
	}) {
		this.options = options;
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
		const top = `┌ ${this.options.title} ${"─".repeat(Math.max(0, width - visibleWidth(this.options.title) - 3))}┐`;
		const bottom = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		const body = (text: string) => `│ ${fitLine(text, bodyWidth)} │`;
		const feedback = this.submitting
			? theme.fg("accent", "Working…")
			: this.status
				? theme.fg(this.status.kind === "error" ? "error" : "muted", this.status.text)
				: "";
		return [
			fitLine(theme.fg("border", top), width),
			body(theme.fg("text", this.options.label)),
			body(this.input.render(bodyWidth)[0] ?? ""),
			body(feedback),
			body(theme.fg("muted", "Enter Confirm · Esc Cancel")),
			fitLine(theme.fg("border", bottom), width),
		];
	}

	private async submit(branchName: string): Promise<void> {
		if (this.submitting) return;
		this.submitting = true;
		this.status = undefined;
		this.options.ui.requestRender();
		let result: GitWorktreeUseCaseActionResult;
		try {
			result = await this.options.onSubmit(branchName);
		} catch (error) {
			result = { ok: false, error: formatError(error) };
		}
		this.submitting = false;
		if (result.ok) {
			this.options.onCompleted(result);
			return;
		}
		this.status = { kind: "error", text: result.error ?? "操作失败。" };
		this.options.ui.requestRender();
	}
}

/** Git Worktree manager opened from the existing `/git` repository surface. */
export class GitWorktreeSidebarComponent implements Component, Focusable {
	private readonly options: GitWorktreeSidebarOptions;
	private worktrees: GitWorktree[] = [];
	private rows: GitWorktree[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private statusMessage: { kind: "error" | "info"; text: string } | undefined;
	private dialogHandle: OverlayHandle | undefined;
	private confirmDeletePath: string | undefined;
	private confirmCombineBranch: string | undefined;
	private busy = false;
	private _focused = false;

	constructor(options: GitWorktreeSidebarOptions) {
		this.options = options;
		this.refresh();
		const currentIndex = this.rows.findIndex((worktree) => this.isCurrentWorktree(worktree));
		if (currentIndex >= 0) this.selectedIndex = currentIndex;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}
	invalidate(): void {}

	private refresh(preferredPath?: string): void {
		const snapshot = this.options.getWorktrees();
		this.worktrees = snapshot.worktrees;
		this.rows = [...this.worktrees];
		if (preferredPath) {
			const index = this.rows.findIndex((worktree) => pathsEqual(worktree.path, preferredPath));
			if (index >= 0) this.selectedIndex = index;
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
		if (snapshot.error) this.statusMessage = { kind: "error", text: snapshot.error };
	}

	private selectedWorktree(): GitWorktree | undefined {
		return this.rows[this.selectedIndex];
	}

	private isCurrentWorktree(worktree: GitWorktree): boolean {
		return getCwdRelativePath(this.options.currentCwd, worktree.path) !== undefined;
	}

	private setStatus(kind: "error" | "info", text: string): void {
		this.statusMessage = { kind, text };
		this.options.ui.requestRender();
	}

	private moveSelection(direction: -1 | 1, count = 1): void {
		if (this.rows.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + direction * count));
		this.options.ui.requestRender();
	}

	private openBranchDialog(kind: "existing" | "new"): void {
		if (this.dialogHandle || this.busy) return;
		let handle: OverlayHandle | undefined;
		const close = () => {
			handle?.hide();
			this.dialogHandle = undefined;
			this.options.ui.requestRender();
		};
		const dialog = new BranchInputDialog({
			ui: this.options.ui,
			title: kind === "existing" ? " Add Existing Branch Worktree " : " Create Branch Worktree ",
			label: kind === "existing" ? "Existing branch name" : "New branch name (created from main)",
			onSubmit: (branchName) =>
				kind === "existing" ? this.options.onCreateExisting(branchName) : this.options.onCreateBranch(branchName),
			onCompleted: (result) => {
				close();
				if (result.ok) {
					this.refresh(result.worktree?.path);
					this.setStatus("info", result.message ?? "Worktree 已创建。");
				} else {
					this.setStatus("error", result.error ?? "操作失败。");
				}
			},
			onCancel: close,
		});
		handle = this.options.ui.showOverlay(dialog, { width: "60%", minWidth: 40, maxWidth: 76, anchor: "center" });
		this.dialogHandle = handle;
	}

	private async deleteSelected(): Promise<void> {
		const worktree = this.selectedWorktree();
		if (!worktree || !this.confirmDeletePath || !pathsEqual(worktree.path, this.confirmDeletePath) || this.busy)
			return;
		this.confirmDeletePath = undefined;
		this.busy = true;
		this.setStatus("info", "正在删除 Worktree…");
		try {
			const result = await this.options.onDelete(worktree);
			if (!result.ok) {
				this.setStatus("error", result.error ?? "删除 Worktree 失败。");
				return;
			}
			this.refresh();
			this.setStatus(
				"info",
				result.warning
					? `${result.message ?? "Worktree 已删除。"}\n${result.warning}`
					: (result.message ?? "Worktree 已删除。"),
			);
		} catch (error) {
			this.setStatus("error", formatError(error));
		} finally {
			this.busy = false;
		}
	}

	private async combineSelected(): Promise<void> {
		const worktree = this.selectedWorktree();
		if (!worktree?.branch || !this.confirmCombineBranch || this.confirmCombineBranch !== worktree.branch || this.busy)
			return;
		this.confirmCombineBranch = undefined;
		this.busy = true;
		this.setStatus("info", "正在把分支合并到 main…");
		try {
			const result = await this.options.onCombine(worktree);
			if (!result.ok) {
				this.setStatus("error", result.error ?? "合并失败。Git 状态已保留，请先处理后再继续。");
				return;
			}
			this.refresh();
			this.setStatus(
				"info",
				result.warning
					? `${result.message ?? "分支已合并。"}\n${result.warning}`
					: (result.message ?? "分支已合并到 main。"),
			);
		} catch (error) {
			this.setStatus("error", formatError(error));
		} finally {
			this.busy = false;
		}
	}

	private async enterSelected(): Promise<void> {
		const worktree = this.selectedWorktree();
		if (!worktree || this.busy) return;
		this.busy = true;
		this.setStatus("info", `正在进入 ${worktree.branch ?? "Detached HEAD"} Worktree…`);
		try {
			const result = await this.options.onEnter(worktree);
			if (!result.ok) {
				this.setStatus("error", result.error ?? "进入 Worktree 失败。");
				return;
			}
			if (result.close) {
				this.options.onClose();
				return;
			}
			this.setStatus("info", result.message ?? "已进入 Worktree。");
		} catch (error) {
			this.setStatus("error", formatError(error));
		} finally {
			this.busy = false;
		}
	}

	private async generateLauncher(): Promise<void> {
		const worktree = this.selectedWorktree();
		if (!worktree || this.busy) return;
		this.busy = true;
		try {
			const result = await this.options.onGenerateLauncher(worktree);
			this.setStatus(
				result.ok ? "info" : "error",
				result.ok ? (result.message ?? "已生成启动文件。") : (result.error ?? "生成启动文件失败。"),
			);
			if (result.ok) this.refresh(worktree.path);
		} catch (error) {
			this.setStatus("error", formatError(error));
		} finally {
			this.busy = false;
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.busy) return;
		if (this.confirmDeletePath) {
			if (kb.matches(data, "tui.select.confirm")) void this.deleteSelected();
			else if (kb.matches(data, "tui.select.cancel")) {
				this.confirmDeletePath = undefined;
				this.options.ui.requestRender();
			}
			return;
		}
		if (this.confirmCombineBranch) {
			if (kb.matches(data, "tui.select.confirm")) void this.combineSelected();
			else if (kb.matches(data, "tui.select.cancel")) {
				this.confirmCombineBranch = undefined;
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

		const worktree = this.selectedWorktree();
		if (matchesKey(data, "a")) {
			this.openBranchDialog("existing");
			return;
		}
		if (matchesKey(data, "n")) {
			this.openBranchDialog("new");
			return;
		}
		if (worktree && matchesKey(data, "d") && !worktree.isMain) {
			this.confirmDeletePath = worktree.path;
			this.options.ui.requestRender();
			return;
		}
		if (worktree && matchesKey(data, "c") && !worktree.isMain && worktree.branch) {
			this.confirmCombineBranch = worktree.branch;
			this.options.ui.requestRender();
			return;
		}
		if (worktree && matchesKey(data, "l")) {
			void this.generateLauncher();
			return;
		}
		if (worktree && kb.matches(data, "tui.select.confirm")) void this.enterSelected();
	}

	render(width: number): string[] {
		const termHeight = Math.max(1, this.options.ui.getTerminalSize().rows);
		const contentWidth = Math.max(0, width - 1);
		const current = this.worktrees.find((worktree) => this.isCurrentWorktree(worktree));
		const main = this.worktrees.find((worktree) => worktree.isMain);
		const header = [
			theme.fg(this._focused ? "accent" : "text", theme.bold("Git · Worktrees")),
			theme.fg("text", `Current · ${current?.branch ?? "not in a registered Worktree"}`),
			theme.fg("dim", truncateToWidth(shortenPath(current?.path ?? this.options.currentCwd), contentWidth, "…")),
			theme.fg("muted", `main · ${shortenPath(main?.path ?? this.options.repositoryRoot)}`),
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
		if (listLines.length === 0) listLines.push(theme.fg("muted", "  No Worktrees"));
		while (listLines.length < viewportHeight) listLines.push("");
		const info = this.confirmDeletePath
			? theme.fg("error", "Remove this Worktree? Enter confirm · Esc cancel")
			: this.confirmCombineBranch
				? theme.fg("error", "Combine this branch into main and remove its Worktree? Enter confirm · Esc cancel")
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
		if (this.selectedIndex >= this.scrollOffset + viewportHeight)
			this.scrollOffset = this.selectedIndex - viewportHeight + 1;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.rows.length - viewportHeight)));
	}

	private renderRow(worktree: GitWorktree, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		const current = this.isCurrentWorktree(worktree);
		const currentMark = current ? theme.fg("accent", "● ") : "  ";
		const branchLabel = worktree.isMain
			? `${worktree.branch ?? "main"} · stable`
			: (worktree.branch ?? "Detached HEAD");
		const launcher = worktree.launcherPath ? " · .cmd" : "";
		const suffix = ` · ${shortenPath(worktree.path)}${launcher}`;
		const prefix = `${cursor}${currentMark}`;
		const nameWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		let name = theme.fg(
			current ? "accent" : worktree.isMain ? "text" : "text",
			truncateToWidth(branchLabel, nameWidth, "…"),
		);
		if (selected) name = theme.bold(name);
		return `${prefix}${name}${theme.fg(worktree.isMain ? "muted" : "dim", suffix)}`;
	}

	private helpLines(width: number): string[] {
		const labels = [
			"↑↓/Pg Move",
			"Enter Enter",
			"A Existing",
			"N New branch",
			"D Remove",
			"C Combine",
			"L .cmd",
			"Esc Back",
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
		return lines;
	}
}
