import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TUI, visibleWidth } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { WorkspaceStore } from "../src/application/workspace-store.ts";
import { deleteSessionFile } from "../src/modes/interactive/components/session-selector.ts";
import { WorkspaceSidebarComponent } from "../src/modes/interactive/components/workspace-sidebar.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write a minimal valid session JSONL file and return its path. */
function createSessionFile(sessionDir: string, options: { id: string; userText: string; userTs: number }): string {
	const created = new Date(options.userTs).toISOString();
	const fileName = `${created.replace(/[:.]/g, "-")}_${options.id}.jsonl`;
	const conversationDir = join(sessionDir, "conversation");
	mkdirSync(conversationDir, { recursive: true });
	const filePath = join(conversationDir, fileName);
	const header = {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: created,
		cwd: sessionDir,
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: created,
		message: { role: "user", content: options.userText, timestamp: options.userTs },
	};
	writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`);
	return filePath;
}

function sessionInfo(
	cwd: string,
	id: string,
	firstMessage: string,
	overrides: Partial<Awaited<ReturnType<typeof SessionManager.list>>[number]> = {},
): Awaited<ReturnType<typeof SessionManager.list>>[number] {
	const date = new Date();
	return {
		path: join(cwd, `${id}.jsonl`),
		id,
		cwd,
		name: undefined,
		parentSessionPath: undefined,
		created: date,
		modified: date,
		messageCount: 1,
		firstMessage,
		allMessagesText: firstMessage,
		...overrides,
	};
}

describe("WorkspaceSidebarComponent", () => {
	let agentDir: string;
	let projectA: string;
	let projectB: string;
	let dataRoot: string;
	let store: WorkspaceStore;
	let ui: TUI;
	let virtual: VirtualTerminal;
	let previousAgentDir: string | undefined;
	let previousCwd: string;
	const openedSessions: string[] = [];
	const newChatCalls: string[] = [];
	let closeCount = 0;
	let listSessions: (cwd: string) => Promise<Awaited<ReturnType<typeof SessionManager.list>>>;

	beforeEach(() => {
		initTheme("dark");
		previousCwd = process.cwd();
		dataRoot = createTempDir("myharness-ws-sidebar-data");
		process.chdir(dataRoot);
		agentDir = createTempDir("myharness-ws-sidebar");
		projectA = createTempDir("myharness-ws-project-a");
		projectB = createTempDir("myharness-ws-project-b");
		// Session listing uses the default agent dir (MYHARNESS_CODING_AGENT_DIR);
		// redirect it to the temp dir so tests never touch the real ~/.myharness.
		previousAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_CODING_AGENT_DIR = agentDir;
		store = WorkspaceStore.create(agentDir);
		store.add(projectA);
		store.add(projectB);
		virtual = new VirtualTerminal(80, 24);
		ui = new TUI(virtual);
		openedSessions.length = 0;
		newChatCalls.length = 0;
		closeCount = 0;
		listSessions = (cwd) => SessionManager.list(cwd);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) {
			delete process.env.MYHARNESS_CODING_AGENT_DIR;
		} else {
			process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
		}
		for (const dir of [dataRoot, agentDir, projectA, projectB]) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		ui.stop();
	});

	function createSidebar(overrides: Partial<ConstructorParameters<typeof WorkspaceSidebarComponent>[0]> = {}) {
		const sidebar = new WorkspaceSidebarComponent({
			ui,
			store,
			currentCwd: projectA,
			listSessions,
			onOpenSession: (sessionPath) => openedSessions.push(sessionPath),
			onNewSessionInWorkspace: async (rootPath) => {
				newChatCalls.push(rootPath);
				return undefined;
			},
			onClose: () => {
				closeCount++;
			},
			...overrides,
		});
		sidebar.focused = true;
		return sidebar;
	}

	function sendKey(sidebar: WorkspaceSidebarComponent, key: string): void {
		sidebar.handleInput(key);
	}

	function renderText(sidebar: WorkspaceSidebarComponent): string {
		return sidebar.render(60).join("\n");
	}

	async function flushTui(): Promise<string> {
		ui.requestRender(true);
		await Promise.resolve();
		await virtual.waitForRender();
		return stripAnsi((await virtual.flushAndGetViewport()).join("\n"));
	}

	async function mountSidebar(sidebar: WorkspaceSidebarComponent): Promise<void> {
		ui.showOverlay(sidebar, { width: 60, anchor: "top-left" });
		ui.start();
		await flushTui();
	}

	describe("rendering", () => {
		it("renders workspaces, actions, and the help line", () => {
			const sidebar = createSidebar();
			const text = renderText(sidebar);
			expect(text).toContain("Workspaces");
			expect(text).toContain("+ New Chat");
			expect(text).toContain("+ Add Workspace");
			expect(text).toContain("myharness-ws-project-a");
			expect(text).toContain("myharness-ws-project-b");
			expect(text).toContain("Esc Close");
			expect(text).toContain("R AI Rename Chat");
			expect(text).toContain("M Manual Rename");
			expect(text).toContain("B Batch AI Rename");
			expect(text).not.toContain(projectA);
		});

		it("expands every workspace on first open", async () => {
			const sidebar = createSidebar({
				listSessions: async (cwd) => [
					sessionInfo(
						cwd,
						cwd === projectA ? "current" : "other",
						`Chat in ${cwd === projectA ? "current" : "other"} workspace`,
					),
				],
			});
			await vi.waitFor(() => expect(stripAnsi(renderText(sidebar))).toContain("Chat in other workspace"));
		});

		it("marks the workspace matching the current cwd", () => {
			const sidebar = createSidebar();
			const text = renderText(sidebar);
			// projectA is the current cwd; its row uses the accent color.
			expect(text).toContain(theme.getFgAnsi("accent"));
		});

		it("shows only registry-backed workspaces when the current directory is unregistered", async () => {
			const emptyStore = WorkspaceStore.create(createTempDir("myharness-ws-empty"));
			// Short cwd name so the row is not width-truncated in assertions.
			const shortCwd = join(tmpdir(), "ws-view-test");
			mkdirSync(shortCwd, { recursive: true });
			const sidebar = createSidebar({
				store: emptyStore,
				currentCwd: shortCwd,
				listSessions: async (cwd) => [sessionInfo(cwd, "u1", "Untracked chat")],
			});
			const text = stripAnsi(renderText(sidebar));
			// Session listing is not used to create a synthetic Workspace row.
			expect(text).not.toContain("Untracked chat");
			expect(text).not.toContain("ws-view-test · untracked");
			expect(text).toContain("+ Add Workspace");
			expect(text).toContain("No workspaces");
			expect(openedSessions).toHaveLength(0);
		});

		it("strictly clips long Chinese, URL, path and ANSI-styled rows to the sidebar width", async () => {
			const chinese = "用户已明确选择 Ultracode 模式，并要求对当前项目全部内容进行完整检查";
			const url = "https://github.com/some-extremely-long-repository-name/with/a/very/long/path";
			const sidebar = createSidebar({
				listSessions: async (cwd) => [sessionInfo(cwd, "cn", chinese), sessionInfo(cwd, "url", url)],
			});
			await vi.waitFor(() => expect(stripAnsi(sidebar.render(28).join("\n"))).toContain("用户"));
			const lines = sidebar.render(28);
			expect(lines.every((line) => visibleWidth(line) === 28)).toBe(true);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("…");
			expect(text).not.toContain(chinese);
			expect(text).not.toContain(url);
		});

		it("shows only understandable relative age metadata, not the old message-count pair", async () => {
			const modified = new Date(Date.now() - 7 * 60 * 60 * 1000);
			const sidebar = createSidebar({
				listSessions: async (cwd) => [sessionInfo(cwd, "age", "Readable title", { messageCount: 26, modified })],
			});
			await vi.waitFor(() => expect(stripAnsi(renderText(sidebar))).toContain("Readable title"));
			const text = stripAnsi(renderText(sidebar));
			expect(text).toContain("7h");
			expect(text).not.toContain("26 7h");
		});

		it("uses separate markers for focus selection, current workspace and current chat", async () => {
			const current = sessionInfo(projectA, "current", "Current chat");
			const sidebar = createSidebar({
				currentSessionPath: current.path,
				listSessions: async (cwd) => (cwd === projectA ? [current] : []),
			});
			await vi.waitFor(() => expect(stripAnsi(renderText(sidebar))).toContain("Current chat"));
			const text = stripAnsi(renderText(sidebar));
			expect(text).toContain("› ▾ ●");
			expect(text.match(/●/g)).toHaveLength(2);
		});
	});

	describe("navigation", () => {
		it("moves selection with up/down", () => {
			const sidebar = createSidebar();
			sendKey(sidebar, "\x1b[B"); // current workspace -> next workspace
			const text = stripAnsi(renderText(sidebar));
			expect(text).toContain("› ▾");
			expect(renderText(sidebar)).not.toContain(theme.getBgAnsi("selectedBg"));
		});

		it("expands a workspace with right and shows its chats", async () => {
			// projectA has two chats (different activity times for ordering).
			const dirA = SessionManager.create(projectA).getSessionDir();
			createSessionFile(dirA, { id: "sess-old", userText: "旧会话", userTs: Date.now() - 60_000 });
			createSessionFile(dirA, { id: "sess-new", userText: "新会话", userTs: Date.now() });

			const sidebar = createSidebar(); // current workspace expands automatically

			await vi.waitFor(() => {
				const text = renderText(sidebar);
				expect(text).toContain("新会话");
				expect(text).toContain("旧会话");
			});

			// Most recent chat is listed first.
			const text = renderText(sidebar);
			expect(text.indexOf("新会话")).toBeLessThan(text.indexOf("旧会话"));
		});

		it("collapses with left and re-expands with enter", async () => {
			const dirA = SessionManager.create(projectA).getSessionDir();
			createSessionFile(dirA, { id: "sess-a", userText: "会话A", userTs: Date.now() });
			const sidebar = createSidebar();

			await vi.waitFor(() => expect(renderText(sidebar)).toContain("会话A"));

			sendKey(sidebar, "\x1b[D"); // left -> collapse
			expect(renderText(sidebar)).not.toContain("会话A");

			sendKey(sidebar, "\r"); // enter -> expand again
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("会话A"));
		});

		it("moves left from a chat to its parent without collapsing the workspace", async () => {
			const sidebar = createSidebar({ listSessions: async (cwd) => [sessionInfo(cwd, "child", "Child chat")] });
			await vi.waitFor(() => expect(stripAnsi(renderText(sidebar))).toContain("Child chat"));
			sendKey(sidebar, "\x1b[B"); // chat
			sendKey(sidebar, "\x1b[D"); // parent workspace
			const text = stripAnsi(renderText(sidebar));
			expect(text).toContain("› ▾ ●");
			expect(text).toContain("Child chat");
		});
	});

	describe("opening chats", () => {
		it("opens the selected chat on enter", async () => {
			const dirA = SessionManager.create(projectA).getSessionDir();
			const sessionPath = createSessionFile(dirA, { id: "sess-a", userText: "会话A", userTs: Date.now() });

			const sidebar = createSidebar();
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("会话A"));
			sendKey(sidebar, "\x1b[B"); // -> chat
			sendKey(sidebar, "\r"); // open
			expect(openedSessions).toEqual([sessionPath]);
		});
	});

	describe("conversation renaming", () => {
		it("supports AI → AI → Manual → AI while keeping the same chat selected", async () => {
			const target = sessionInfo(projectA, "rename", "Old title");
			const renamed: string[] = [];
			const manual: string[] = [];
			let aiRun = 0;
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [target] : []),
				onRenameSession: async (sessionPath, signal) => {
					renamed.push(`${sessionPath}:${signal?.aborted ?? false}`);
					aiRun++;
					return { status: "renamed", title: `AI generated title ${aiRun}` };
				},
				onRenameSessionManually: async (sessionPath, title) => {
					manual.push(`${sessionPath}:${title}`);
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Old title"));

			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("AI Rename complete: AI generated title 1"));
			sendKey(sidebar, "r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("AI Rename complete: AI generated title 2"));

			sendKey(sidebar, "m");
			expect(renderText(sidebar)).toContain("Rename conversation");
			for (const character of "手动标题") sendKey(sidebar, character);
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Conversation renamed: 手动标题"));

			sendKey(sidebar, "r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("AI Rename complete: AI generated title 3"));
			expect(renamed).toEqual([`${target.path}:false`, `${target.path}:false`, `${target.path}:false`]);
			expect(manual).toEqual([`${target.path}:手动标题`]);
			const finalTitleLines = stripAnsi(renderText(sidebar))
				.split("\n")
				.filter((line) => line.includes("AI generated title 3"));
			expect(finalTitleLines.length).toBe(2); // tree row + status line
		});

		it("blocks duplicate single requests while running and unlocks after completion", async () => {
			const target = sessionInfo(projectA, "single-flight", "Single flight");
			let calls = 0;
			const releases: Array<() => void> = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [target] : []),
				onRenameSession: async () => {
					const run = ++calls;
					await new Promise<void>((resolve) => releases.push(resolve));
					return { status: "renamed", title: `Generated title ${run}` };
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Single flight"));

			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "r");
			await vi.waitFor(() => expect(releases).toHaveLength(1));
			sendKey(sidebar, "r");
			expect(calls).toBe(1);

			releases.shift()!();
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("AI Rename complete: Generated title 1"));
			sendKey(sidebar, "r");
			await vi.waitFor(() => expect(releases).toHaveLength(1));
			expect(calls).toBe(2);
			releases.shift()!();
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("AI Rename complete: Generated title 2"));
		});

		it("marks a deterministic AI title fallback as a fallback", async () => {
			const target = sessionInfo(projectA, "fallback", "Fallback source");
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [target] : []),
				onRenameSession: async () => ({ status: "renamed", title: "Fallback source", usedFallback: true }),
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Fallback source"));

			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("AI Rename fallback: Fallback source"));
		});

		it("keeps batch mode active until the post-batch session refresh finishes", async () => {
			const target = sessionInfo(projectA, "batch-refresh", "Batch refresh");
			let delayNextProjectLoad = false;
			let releaseRefresh: (() => void) | undefined;
			let batchRuns = 0;
			const sidebar = createSidebar({
				listSessions: async (cwd) => {
					if (cwd !== projectA) return [];
					if (delayNextProjectLoad) {
						delayNextProjectLoad = false;
						await new Promise<void>((resolve) => {
							releaseRefresh = resolve;
						});
					}
					return [target];
				},
				onRenameAllSessions: async (_rootPath, _signal, onProgress) => {
					batchRuns++;
					onProgress({ total: 1, processed: 1, renamed: 1, skipped: 0, failed: 0, cancelled: 0 });
					return {
						total: 1,
						processed: 1,
						renamed: 1,
						skipped: 0,
						failed: 0,
						cancelled: 0,
						cancelledByUser: false,
						remaining: 0,
					};
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Batch refresh"));

			delayNextProjectLoad = true;
			sendKey(sidebar, "b");
			await vi.waitFor(() => expect(releaseRefresh).toBeDefined());
			sendKey(sidebar, "b");
			expect(batchRuns).toBe(1);

			releaseRefresh!();
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Batch AI Rename complete: 1 renamed"));
			sendKey(sidebar, "b");
			await vi.waitFor(() => expect(batchRuns).toBe(2));
		});

		it("validates, trims, persists, and cancels manual titles without moving selection", async () => {
			const target = sessionInfo(projectA, "manual", "Original title");
			const manual: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [target] : []),
				onRenameSessionManually: async (sessionPath, title) => {
					manual.push(`${sessionPath}:${title}`);
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Original title"));

			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "m");
			sendKey(sidebar, "\r");
			expect(renderText(sidebar)).toContain("Conversation name cannot be empty.");
			expect(manual).toEqual([]);

			for (const character of "  上下文  压缩机制  ") sendKey(sidebar, character);
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Conversation renamed: 上下文 压缩机制"));
			expect(manual).toEqual([`${target.path}:上下文 压缩机制`]);
			expect(stripAnsi(renderText(sidebar))).toContain("上下文 压缩机制");

			sendKey(sidebar, "m");
			for (const character of "暂不保存") sendKey(sidebar, character);
			sendKey(sidebar, "\x1b");
			expect(manual).toHaveLength(1);
			expect(renderText(sidebar)).not.toContain("暂不保存");
			expect(renderText(sidebar)).toContain("Manual Rename cancelled.");
		});

		it("runs batch rename repeatedly for the selected workspace", async () => {
			let batchRuns = 0;
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [sessionInfo(cwd, "batch", "Batch chat")] : []),
				onRenameAllSessions: async (rootPath, signal, onProgress) => {
					expect(rootPath).toBe(projectA);
					expect(signal.aborted).toBe(false);
					batchRuns++;
					onProgress({ total: 1, processed: 1, renamed: 1, skipped: 0, failed: 0, cancelled: 0 });
					return {
						total: 1,
						processed: 1,
						renamed: 1,
						skipped: 0,
						failed: 0,
						cancelled: 0,
						cancelledByUser: false,
						remaining: 0,
					};
				},
			});

			sendKey(sidebar, "b");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Batch AI Rename complete: 1 renamed"));
			sendKey(sidebar, "b");
			await vi.waitFor(() => expect(batchRuns).toBe(2));
		});
	});

	describe("creating chats", () => {
		it("creates a chat in the selected workspace with the n key", async () => {
			const sidebar = createSidebar();
			sendKey(sidebar, "n");
			await vi.waitFor(() => expect(newChatCalls).toEqual([projectA]));
		});

		it("creates a chat in the current workspace from the + New Chat row", async () => {
			const sidebar = createSidebar();
			sendKey(sidebar, "\x1b[A"); // current workspace -> Add Workspace
			sendKey(sidebar, "\x1b[A"); // -> New Chat
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(newChatCalls).toEqual([projectA]));
		});

		it("does not create a chat without a selected registry-backed workspace", async () => {
			const emptyStore = WorkspaceStore.create(createTempDir("myharness-ws-empty"));
			const sidebar = createSidebar({ store: emptyStore });
			sendKey(sidebar, "n");
			expect(newChatCalls).toEqual([]);
			expect(renderText(sidebar)).toContain("请先添加 Workspace");
		});

		it("does not silently create a chat when the current cwd is not in the list", async () => {
			const otherCwd = createTempDir("myharness-ws-other");
			const sidebar = createSidebar({ currentCwd: otherCwd });
			sendKey(sidebar, "n"); // N = New Chat
			expect(newChatCalls).toEqual([]);
			expect(renderText(sidebar)).toContain("请先添加 Workspace");
			if (existsSync(otherCwd)) rmSync(otherCwd, { recursive: true, force: true });
		});

		it("surfaces runtime failures from onNewSessionInWorkspace", async () => {
			const sidebar = createSidebar({
				onNewSessionInWorkspace: async () => "创建 Chat 失败：boom",
			});
			sendKey(sidebar, "n");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("创建 Chat 失败：boom"));
		});
	});

	describe("adding workspaces", () => {
		it("adds a workspace through a focus-capturing modal", async () => {
			const sidebar = createSidebar();
			await mountSidebar(sidebar);
			virtual.sendInput("a");
			expect(await flushTui()).toContain("Add Workspace");
			expect(sidebar.focused).toBe(false);
			const newProject = createTempDir("myharness-ws-project-c");
			for (const ch of newProject) virtual.sendInput(ch);
			virtual.sendInput("\r");
			await flushTui();
			expect(store.list().some((w) => w.rootPath === newProject)).toBe(true);
			expect(sidebar.focused).toBe(true);
			expect(renderText(sidebar)).toContain("myharness-ws-project-c");
		});

		it("keeps validation errors inside the add-workspace modal", async () => {
			const sidebar = createSidebar();
			await mountSidebar(sidebar);
			virtual.sendInput("a");
			for (const ch of "z:\\x") virtual.sendInput(ch);
			virtual.sendInput("\r");
			expect(await flushTui()).toContain("路径不存在");
			expect(sidebar.focused).toBe(false);
		});

		it("cancels the modal with escape and restores sidebar focus", async () => {
			const sidebar = createSidebar();
			await mountSidebar(sidebar);
			virtual.sendInput("a");
			await flushTui();
			virtual.sendInput("\x1b");
			const text = await flushTui();
			expect(text).toContain("Workspaces");
			expect(text).not.toContain("Path");
			expect(sidebar.focused).toBe(true);
		});
	});

	describe("deleting chats", () => {
		it("requires confirmation before deleting a selected chat", async () => {
			const deleted: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [sessionInfo(cwd, "del", "Delete me")] : []),
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Delete me"));

			sendKey(sidebar, "\x1b[B"); // select chat
			sendKey(sidebar, "d");
			expect(renderText(sidebar)).toContain("Delete this chat?");
			expect(deleted).toEqual([]);

			sendKey(sidebar, "\r"); // confirm
			await vi.waitFor(() => expect(deleted).toHaveLength(1));
			await vi.waitFor(() => expect(renderText(sidebar)).not.toContain("Delete me"));
		});

		it("esc cancels chat deletion without calling the callback", async () => {
			const deleted: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => [sessionInfo(cwd, "del", "Keep me")],
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Keep me"));
			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\x1b");
			expect(deleted).toEqual([]);
			expect(renderText(sidebar)).not.toContain("Delete this chat?");
		});

		it("surfaces a delete failure as an error and keeps the chat", async () => {
			const sidebar = createSidebar({
				listSessions: async (cwd) => [sessionInfo(cwd, "del", "Stays")],
				deleteSession: async () => "不能删除正在运行的会话。",
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Stays"));
			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("不能删除正在运行的会话。"));
			expect(renderText(sidebar)).toContain("Stays");
		});

		it("surfaces thrown chat deletion failures as an error and keeps the chat", async () => {
			const sidebar = createSidebar({
				listSessions: async (cwd) => [sessionInfo(cwd, "del", "Stays after throw")],
				deleteSession: async () => {
					throw new Error("disk failure");
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Stays after throw"));
			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("disk failure"));
			expect(renderText(sidebar)).toContain("Stays after throw");
		});

		it("selects multiple chats, confirms once, and removes only the selected chats", async () => {
			const first = sessionInfo(projectA, "batch-first", "Batch first");
			const second = sessionInfo(projectA, "batch-second", "Batch second");
			let remaining = [first, second];
			const deleted: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [...remaining] : []),
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					remaining = remaining.filter((session) => session.path !== sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Batch first"));

			sendKey(sidebar, "x");
			expect(renderText(sidebar)).toContain("Batch Delete");
			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, " ");
			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, " ");
			expect(renderText(sidebar)).toContain("Selected: 2 sessions");

			sendKey(sidebar, "d");
			expect(renderText(sidebar)).toContain("Delete 2 selected sessions?");
			expect(deleted).toEqual([]);
			sendKey(sidebar, "\r");

			await vi.waitFor(() => expect(deleted).toHaveLength(2));
			await vi.waitFor(() => {
				expect(renderText(sidebar)).not.toContain("Batch first");
				expect(renderText(sidebar)).not.toContain("Batch second");
			});
			expect(renderText(sidebar)).not.toContain("Selected:");
		});

		it("uses the real session-file deletion path instead of only hiding chats", async () => {
			const sessionDir = SessionManager.create(projectA).getSessionDir();
			const firstPath = createSessionFile(sessionDir, {
				id: "persist-first",
				userText: "Persist first",
				userTs: Date.now() - 1000,
			});
			const secondPath = createSessionFile(sessionDir, {
				id: "persist-second",
				userText: "Persist second",
				userTs: Date.now(),
			});
			const sidebar = createSidebar({
				deleteSession: async (sessionPath) => {
					const result = await deleteSessionFile(sessionPath);
					return result.ok ? undefined : result.error;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Persist second"));

			sendKey(sidebar, "x");
			sendKey(sidebar, "a");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");

			await vi.waitFor(() => {
				expect(existsSync(firstPath)).toBe(false);
				expect(existsSync(secondPath)).toBe(false);
			});
		});

		it("defines Select All as all chats in the selected Workspace", async () => {
			const projectChat = sessionInfo(projectA, "workspace-a", "Workspace A chat");
			const otherChat = sessionInfo(projectB, "workspace-b", "Workspace B chat");
			let remainingA = [projectChat];
			let remainingB = [otherChat];
			const deleted: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [...remainingA] : [...remainingB]),
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					remainingA = remainingA.filter((session) => session.path !== sessionPath);
					remainingB = remainingB.filter((session) => session.path !== sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Workspace B chat"));

			sendKey(sidebar, "x");
			sendKey(sidebar, "a");
			expect(renderText(sidebar)).toContain("[x]");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");

			await vi.waitFor(() => expect(deleted).toEqual([projectChat.path]));
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Workspace B chat"));
			expect(deleted).not.toContain(otherChat.path);
		});

		it("keeps failed chats selected and reports partial deletion", async () => {
			const first = sessionInfo(projectA, "partial-first", "Partial first");
			const failed = sessionInfo(projectA, "partial-failed", "Partial failed");
			const last = sessionInfo(projectA, "partial-last", "Partial last");
			let remaining = [first, failed, last];
			const deleted: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [...remaining] : []),
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					if (sessionPath === failed.path) return "disk failure";
					remaining = remaining.filter((session) => session.path !== sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Partial first"));

			sendKey(sidebar, "x");
			sendKey(sidebar, "a");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");

			await vi.waitFor(() => expect(deleted).toHaveLength(3));
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Deleted 2 of 3 sessions."));
			expect(renderText(sidebar)).toContain("Partial failed");
			expect(renderText(sidebar)).not.toContain("Partial first");
			expect(renderText(sidebar)).not.toContain("Partial last");
			expect(renderText(sidebar)).toContain("disk failure");
		});

		it("does not delete an empty selection, prevents duplicate submits, and clears state on cancel", async () => {
			const first = sessionInfo(projectA, "guard-first", "Guard first");
			const second = sessionInfo(projectA, "guard-second", "Guard second");
			let remaining = [first, second];
			const deleted: string[] = [];
			let releaseFirst!: () => void;
			const firstDelete = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [...remaining] : []),
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					if (deleted.length === 1) await firstDelete;
					remaining = remaining.filter((session) => session.path !== sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Guard first"));

			sendKey(sidebar, "x");
			sendKey(sidebar, "d");
			expect(deleted).toEqual([]);
			expect(renderText(sidebar)).toContain("Select at least one chat before deleting.");
			sendKey(sidebar, "a");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");
			expect(deleted).toHaveLength(1);

			releaseFirst();
			await vi.waitFor(() => expect(deleted).toHaveLength(2));

			const cancelSidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [first] : []),
				deleteSession: async (sessionPath) => {
					deleted.push(sessionPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(cancelSidebar)).toContain("Guard first"));
			sendKey(cancelSidebar, "x");
			sendKey(cancelSidebar, "\x1b[B");
			sendKey(cancelSidebar, " ");
			sendKey(cancelSidebar, "\x1b");
			expect(renderText(cancelSidebar)).not.toContain("[x]");
			sendKey(cancelSidebar, "x");
			expect(renderText(cancelSidebar)).toContain("Selected: 0 sessions");
		});

		it("tracks the new active session after deleting the old active chat", async () => {
			const oldActive = sessionInfo(projectA, "old-active", "Old active");
			const newActive = sessionInfo(projectA, "new-active", "New active");
			let activePath = oldActive.path;
			let remaining = [oldActive];
			const sidebar = createSidebar({
				currentSessionPath: oldActive.path,
				getCurrentSessionPath: () => activePath,
				listSessions: async (cwd) => (cwd === projectA ? [...remaining] : []),
				deleteSession: async () => {
					activePath = newActive.path;
					remaining = [newActive];
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("Old active"));

			sendKey(sidebar, "x");
			sendKey(sidebar, "\x1b[B");
			sendKey(sidebar, " ");
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");

			await vi.waitFor(() => expect(renderText(sidebar)).toContain("New active"));
			const text = stripAnsi(renderText(sidebar));
			expect(text.match(/●/g)).toHaveLength(2);
		});

		it("deletes the selected workspace and its chats after confirm", async () => {
			const cleared: string[] = [];
			const sidebar = createSidebar({
				listSessions: async (cwd) => (cwd === projectA ? [sessionInfo(cwd, "del", "History")] : []),
				clearSessions: async (rootPath) => {
					cleared.push(rootPath);
					return undefined;
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("History"));

			sendKey(sidebar, "d"); // selected workspace -> delete workspace
			expect(renderText(sidebar)).toContain("Delete this workspace and its chat history?");
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(cleared).toEqual([projectA]));
			await vi.waitFor(() => expect(store.list().map((w) => w.rootPath)).toEqual([projectB]));
			await vi.waitFor(() => expect(renderText(sidebar)).not.toContain("History"));
			expect(stripAnsi(renderText(sidebar))).not.toMatch(/[▸▾] +myharness-ws-project-a/);
		});

		it("keeps the workspace when clearing its chats throws", async () => {
			const sidebar = createSidebar({
				listSessions: async (cwd) => [sessionInfo(cwd, "del", "History remains")],
				clearSessions: async () => {
					throw new Error("clear failure");
				},
			});
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("History remains"));
			sendKey(sidebar, "d");
			sendKey(sidebar, "\r");
			await vi.waitFor(() => expect(renderText(sidebar)).toContain("clear failure"));
			expect(store.list().some((workspace) => workspace.rootPath === projectA)).toBe(true);
		});
	});

	describe("async loading", () => {
		it("discards stale session list results after collapse/re-expand", async () => {
			let resolveFirst!: (sessions: Awaited<ReturnType<typeof SessionManager.list>>) => void;
			const firstLoad = new Promise<Awaited<ReturnType<typeof SessionManager.list>>>((resolve) => {
				resolveFirst = resolve;
			});
			const calls: string[] = [];
			const sidebar = createSidebar({
				initialExpandedIds: [store.getByRootPath(projectA)!.id],
				listSessions: async (cwd) => {
					calls.push(cwd);
					if (calls.length === 1) {
						// First load stays pending until we release it.
						return firstLoad;
					}
					return [];
				},
			});

			await vi.waitFor(() => expect(calls).toHaveLength(1));

			sendKey(sidebar, "\x1b[D"); // collapse
			sendKey(sidebar, "\x1b[C"); // re-expand (second load resolves immediately)
			await vi.waitFor(() => expect(calls).toHaveLength(2));

			// Release the stale first load with an outdated session list.
			const staleSession: Awaited<ReturnType<typeof SessionManager.list>>[number] = {
				path: join(projectA, "stale.jsonl"),
				id: "stale",
				cwd: projectA,
				name: undefined,
				parentSessionPath: undefined,
				created: new Date(),
				modified: new Date(),
				messageCount: 1,
				firstMessage: "陈旧会话",
				allMessagesText: "陈旧会话",
			};
			resolveFirst([staleSession]);
			await vi.waitFor(() => {
				// The stale result must NOT appear in the list.
				expect(renderText(sidebar)).not.toContain("陈旧会话");
			});
		});
	});

	describe("rendering size", () => {
		it("fills the full terminal height", () => {
			const sidebar = createSidebar();
			const lines = sidebar.render(60);
			expect(lines.length).toBe(virtual.rows);
		});

		it("keeps header, footer and selection visible while independently scrolling many chats", async () => {
			virtual.resize(50, 12);
			const sessions = Array.from({ length: 40 }, (_, index) =>
				sessionInfo(projectA, `chat-${index}`, `Chat ${String(index).padStart(2, "0")}`),
			);
			const sidebar = createSidebar({ listSessions: async (cwd) => (cwd === projectA ? sessions : []) });
			await vi.waitFor(() => expect(stripAnsi(sidebar.render(30).join("\n"))).toContain("/ 46"));
			for (let i = 0; i < 25; i++) sendKey(sidebar, "\x1b[B");
			const text = stripAnsi(sidebar.render(30).join("\n"));
			expect(text).toContain("Workspaces");
			expect(text).toContain("Esc");
			expect(text).toContain("›");
			expect(text).toMatch(/↑ \d+–\d+ \/ \d+ ↓/);
			expect(text).not.toContain("Chat 00");
		});

		it("reports expansion changes so non-current workspaces can be restored on reopen", async () => {
			let remembered = new Set<string>();
			const sidebar = createSidebar({
				initialExpandedIds: [store.getByRootPath(projectA)!.id],
				listSessions: async () => [],
				onExpandedIdsChange: (ids) => {
					remembered = new Set(ids);
				},
			});
			await vi.waitFor(() => expect(stripAnsi(renderText(sidebar)).match(/\+ New Chat/g)).toHaveLength(2));
			sendKey(sidebar, "\x1b[B"); // current workspace's empty-state action
			sendKey(sidebar, "\x1b[B"); // second workspace
			sendKey(sidebar, "\x1b[C");
			expect(remembered.size).toBe(2);

			const calls: string[] = [];
			createSidebar({
				initialExpandedIds: remembered,
				listSessions: async (cwd) => {
					calls.push(cwd);
					return [];
				},
			});
			expect(calls).toEqual(expect.arrayContaining([projectA, projectB]));
		});
	});

	describe("closing", () => {
		it("closes on escape", () => {
			const sidebar = createSidebar();
			sendKey(sidebar, "\x1b");
			expect(closeCount).toBe(1);
		});
	});

	describe("overlay integration", () => {
		it("captures focus when shown and restores it when hidden", () => {
			const sidebar = createSidebar();
			const handle = ui.showOverlay(sidebar, { width: "40%", minWidth: 24, anchor: "left-center" });
			expect(handle.isFocused()).toBe(true);
			handle.hide();
			expect(handle.isFocused()).toBe(false);
		});
	});
});
