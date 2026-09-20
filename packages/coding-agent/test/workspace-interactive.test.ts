import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Text } from "../../tui/src/components/text.ts";
import { Container, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { WorkspaceStore } from "../src/application/workspace-store.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function createTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("InteractiveMode /workspace sidebar integration", () => {
	let agentDir: string;
	let projectA: string;
	let store: WorkspaceStore;
	let ui: TUI;
	let virtual: VirtualTerminal;

	beforeEach(() => {
		initTheme("dark");
		agentDir = createTempDir("myharness-ws-int-agent");
		projectA = createTempDir("myharness-ws-int-project");
		store = WorkspaceStore.create(agentDir);
		store.add(projectA);
		virtual = new VirtualTerminal(80, 24);
		ui = new TUI(virtual);
		ui.addChild(new Text("BASE_CHAT", 1, 1));
		ui.start();
	});

	afterEach(() => {
		ui.stop();
		for (const dir of [agentDir, projectA]) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("opens a full-screen Workspace view and restores chat on escape", async () => {
		type SidebarHost = {
			ui: TUI;
			workspaceStore: WorkspaceStore;
			workspaceSidebar: unknown;
			workspaceSidebarHandle: unknown;
			sessionManager: { usesDefaultSessionDir(): boolean; getCwd(): string; getSessionDir(): string };
			session: { sessionFile: string | undefined };
			runtimeHost: object;
			chatContainer: Container;
			createProjectTrustContext(): object;
			closeWorkspaceSidebar(): void;
		};
		const host: SidebarHost = {
			ui,
			workspaceStore: store,
			workspaceSidebar: undefined,
			workspaceSidebarHandle: undefined,
			sessionManager: {
				usesDefaultSessionDir: () => true,
				getCwd: () => projectA,
				getSessionDir: () => "",
			},
			session: { sessionFile: undefined },
			runtimeHost: {},
			chatContainer: new Container(),
			createProjectTrustContext: () => ({}),
			closeWorkspaceSidebar: () => {
				const close = (
					InteractiveMode as unknown as {
						prototype: { closeWorkspaceSidebar(this: SidebarHost): void };
					}
				).prototype.closeWorkspaceSidebar;
				close.call(host);
			},
		};

		const showWorkspaceSidebar = (
			InteractiveMode as unknown as {
				prototype: { showWorkspaceSidebar(this: SidebarHost): void };
			}
		).prototype.showWorkspaceSidebar;
		showWorkspaceSidebar.call(host);

		await flushTui(ui, virtual);
		const opened = stripAnsi((await virtual.flushAndGetViewport()).join("\n"));
		expect(opened).toContain("Workspaces");
		expect(opened).toContain("+ Add Workspace");
		expect(opened).toContain("myharness-ws-int-project");
		expect(opened).not.toContain("BASE_CHAT");
		expect(opened.split("\n")).toHaveLength(24); // full terminal height
		expect(opened.split("\n")[0]?.indexOf("│")).toBe(79); // full terminal width

		virtual.resize(200, 24);
		await flushTui(ui, virtual);
		const wide = stripAnsi((await virtual.flushAndGetViewport()).join("\n"));
		expect(wide.split("\n")[0]?.indexOf("│")).toBe(199); // full terminal width

		virtual.resize(50, 24);
		await flushTui(ui, virtual);
		const compact = stripAnsi((await virtual.flushAndGetViewport()).join("\n"));
		expect(compact.split("\n")[0]?.indexOf("│")).toBe(49); // full terminal width

		virtual.resize(20, 24);
		await flushTui(ui, virtual);
		const narrow = stripAnsi((await virtual.flushAndGetViewport()).join("\n"));
		expect(narrow.split("\n")[0]?.indexOf("│")).toBe(19); // narrow terminals become full-width overlays

		// Escape is handled by the sidebar (it has focus) and closes the overlay.
		virtual.sendInput("\x1b");
		await flushTui(ui, virtual);
		const closed = stripAnsi((await virtual.flushAndGetViewport()).join("\n"));
		expect(closed).not.toContain("Workspaces");
		expect(closed).toContain("BASE_CHAT");
		expect(host.workspaceSidebar).toBeUndefined();
		expect(host.workspaceSidebarHandle).toBeUndefined();
	});

	it("deduplicates direct AI rename calls by stable session path and clears the lock", async () => {
		type RenameHost = {
			activeConversationRenames: Map<string, Promise<unknown>>;
			performRenameSessionWithAi: (sessionPath: string, signal?: AbortSignal) => Promise<unknown>;
		};
		let calls = 0;
		let release: (() => void) | undefined;
		const result = new Promise<{ status: "renamed"; title: string }>((resolve) => {
			release = () => resolve({ status: "renamed", title: "stable title" });
		});
		const host: RenameHost = {
			activeConversationRenames: new Map(),
			performRenameSessionWithAi: async () => {
				calls++;
				return result;
			},
		};
		const rename = (
			InteractiveMode as unknown as {
				prototype: {
					renameSessionWithAi(this: RenameHost, sessionPath: string, signal?: AbortSignal): Promise<unknown>;
				};
			}
		).prototype.renameSessionWithAi;

		const first = rename.call(host, projectA);
		const duplicate = rename.call(host, projectA);
		expect(duplicate).toBe(first);
		expect(calls).toBe(1);
		release!();
		await first;

		const afterCompletion = rename.call(host, projectA);
		expect(afterCompletion).not.toBe(first);
		expect(calls).toBe(2);
	});
});
