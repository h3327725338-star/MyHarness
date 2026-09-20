import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { LocalGitRepository } from "../src/git/local-repositories/store.ts";
import { LocalGitRepositorySidebarComponent } from "../src/modes/interactive/components/local-git-repository-sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!gitAvailable)("LocalGitRepositorySidebarComponent", () => {
	let tempDir: string;
	let terminal: VirtualTerminal;
	let ui: TUI;

	beforeEach(() => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "myharness-local-git-sidebar-"));
		terminal = new VirtualTerminal(80, 24);
		ui = new TUI(terminal);
	});

	afterEach(() => {
		ui.stop();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function flush(): Promise<string> {
		ui.requestRender(true);
		await Promise.resolve();
		await terminal.waitForRender();
		return stripAnsi((await terminal.flushAndGetViewport()).join("\n"));
	}

	function mount(options: ConstructorParameters<typeof LocalGitRepositorySidebarComponent>[0]) {
		const sidebar = new LocalGitRepositorySidebarComponent(options);
		ui.showOverlay(sidebar, { width: "100%", anchor: "top-left" });
		ui.start();
		return sidebar;
	}

	it("requires a second confirmation before initializing a selected non-Git folder", async () => {
		const directory = join(tempDir, "project");
		mkdirSync(directory);
		const calls: Array<{ path: string; initialize: boolean }> = [];
		let repositories: LocalGitRepository[] = [];
		mount({
			ui,
			currentCwd: tempDir,
			getRepositories: () => repositories,
			onAdd: async (path, initialize) => {
				calls.push({ path, initialize });
				if (!initialize) return { ok: false, requiresInitialization: true };
				repositories = [
					{
						id: directory,
						name: "project",
						rootPath: directory,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				];
				return { ok: true, rootPath: directory, message: "initialized" };
			},
			onInitialize: async () => ({ ok: true }),
			onDelete: async () => ({ ok: true }),
			onRename: async () => ({ ok: true }),
			onMove: async () => ({ ok: true }),
			onClose: () => undefined,
		});

		terminal.sendInput("a");
		expect(await flush()).toContain("Add / Initialize Repository");
		for (const character of directory) terminal.sendInput(character);
		terminal.sendInput("\r");
		await vi.waitFor(async () => expect(await flush()).toContain("再次按 Enter 初始化"));
		expect(calls).toEqual([{ path: directory, initialize: false }]);

		terminal.sendInput("\r");
		await vi.waitFor(() =>
			expect(calls).toEqual([
				{ path: directory, initialize: false },
				{ path: directory, initialize: true },
			]),
		);
		expect(await flush()).toContain("initialized");
	});

	it("requires confirmation before delegating .git deletion", async () => {
		const directory = join(tempDir, "repository");
		mkdirSync(directory);
		const repository: LocalGitRepository = {
			id: directory,
			name: "repository",
			rootPath: directory,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		let repositories = [repository];
		const deleted: string[] = [];
		mount({
			ui,
			currentCwd: tempDir,
			getRepositories: () => repositories,
			onAdd: async () => ({ ok: true }),
			onInitialize: async () => ({ ok: true }),
			onDelete: async (selected) => {
				deleted.push(selected.rootPath);
				repositories = [];
				return { ok: true, message: "metadata removed" };
			},
			onRename: async () => ({ ok: true }),
			onMove: async () => ({ ok: true }),
			onClose: () => undefined,
		});

		terminal.sendInput("\x1b[B");
		terminal.sendInput("d");
		expect(await flush()).toContain("Delete only this repository's .git?");
		expect(deleted).toEqual([]);

		terminal.sendInput("\r");
		await vi.waitFor(() => expect(deleted).toEqual([directory]));
		expect(await flush()).toContain("metadata removed");
	});
});
