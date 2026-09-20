import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionConversationPath, getSessionMetadataPath } from "../src/config/paths/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { runMigrations } from "../src/migrations.ts";
import { cleanupEmptySessionDirectories, removeEmptySessionDirectory } from "../src/session/storage/jsonl/index.ts";

describe("Session storage retirement", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "myharness-session-retirement-"));
		roots.push(root);
		return root;
	}

	function withAgentDir<T>(agentDir: string, callback: () => T): T {
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			return callback();
		} finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
		}
	}

	function writeSession(filePath: string, id: string, cwd: string): void {
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(
			filePath,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
			"utf8",
		);
	}

	it("does not recreate project data/sessions on a fresh startup", () => {
		const root = createRoot();
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(project, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		withAgentDir(agentDir, () => runMigrations(project));

		expect(existsSync(join(project, "data", "sessions"))).toBe(false);
	});

	it("retires a completed project legacy tree only after it contains empty shells", () => {
		const root = createRoot();
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		const legacyRoot = join(project, "data", "sessions");
		mkdirSync(join(legacyRoot, "old-shell", "conversation"), { recursive: true });
		writeFileSync(join(legacyRoot, ".legacy-session-storage-migrated.json"), '{"version":2}\n', "utf8");
		mkdirSync(agentDir, { recursive: true });

		withAgentDir(agentDir, () => runMigrations(project));

		expect(existsSync(legacyRoot)).toBe(false);
	});

	it("imports the old global Session tree directly into Workspace storage", () => {
		const root = createRoot();
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		const source = join(agentDir, "sessions", "legacy-project", "old-session.jsonl");
		mkdirSync(project, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSession(source, "old-global-session", project);

		withAgentDir(agentDir, () => runMigrations(project));

		const dataRoot = join(project, "data");
		const workspace = WorkspaceStore.create(agentDir, dataRoot).getByRootPath(project);
		expect(workspace).toBeDefined();
		expect(existsSync(source)).toBe(false);
		expect(existsSync(join(dataRoot, "sessions"))).toBe(false);
		const target = getSessionConversationPath(
			dataRoot,
			workspace!.workspaceId,
			"old-global-session",
			"old-session.jsonl",
		);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(getSessionMetadataPath(dataRoot, workspace!.workspaceId, "old-global-session"))).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8").split("\n")[0]!).workspaceId).toBe(workspace!.workspaceId);
	});

	it("accepts a newly discovered explicit legacy source after the migration marker exists", () => {
		const root = createRoot();
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		const source = join(agentDir, "sessions", "late", "late-session.jsonl");
		mkdirSync(project, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		withAgentDir(agentDir, () => runMigrations(project));
		writeSession(source, "late-global-session", project);
		withAgentDir(agentDir, () => runMigrations(project));

		const dataRoot = join(project, "data");
		const workspace = WorkspaceStore.create(agentDir, dataRoot).getByRootPath(project);
		expect(workspace).toBeDefined();
		expect(existsSync(source)).toBe(false);
		expect(
			existsSync(
				getSessionConversationPath(dataRoot, workspace!.workspaceId, "late-global-session", "late-session.jsonl"),
			),
		).toBe(true);
	});

	it("removes only old empty Session shells and keeps a shell with a sidecar", () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		const emptySession = join(dataRoot, "workspaces", "workspace-1", "sessions", "empty-session", "conversation");
		const sidecarSession = join(dataRoot, "workspaces", "workspace-1", "sessions", "sidecar-session", "tool-results");
		mkdirSync(emptySession, { recursive: true });
		mkdirSync(sidecarSession, { recursive: true });
		writeFileSync(join(sidecarSession, "result.txt"), "recovery value");
		const old = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(emptySession, old, old);
		utimesSync(join(emptySession, ".."), old, old);

		const removed = cleanupEmptySessionDirectories(dataRoot, { minAgeMs: 1_000 });
		expect(removed).toContain(join(dataRoot, "workspaces", "workspace-1", "sessions", "empty-session"));
		expect(existsSync(join(dataRoot, "workspaces", "workspace-1", "sessions", "empty-session"))).toBe(false);
		expect(existsSync(join(dataRoot, "workspaces", "workspace-1", "sessions", "sidecar-session"))).toBe(true);
		expect(
			removeEmptySessionDirectory(
				join(dataRoot, "workspaces", "workspace-1", "sessions", "sidecar-session"),
				"sidecar-session",
			),
		).toBe(false);
	});
});
