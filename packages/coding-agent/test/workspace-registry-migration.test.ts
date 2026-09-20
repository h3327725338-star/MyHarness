import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getSessionConversationPath,
	getSessionDir,
	getWorkspaceRegistryMigrationMarkerPath,
	getWorkspaceUnresolvedPath,
} from "../src/config/paths/index.ts";
import { migrateWorkspaceRegistry } from "../src/data/workspace-registry-migration.ts";
import { findWorkspaceDataContext, WorkspaceStore } from "../src/data/workspace-store.ts";
import { SessionManager } from "../src/session/manager/index.ts";

describe("Workspace registry and Session storage", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	function createTempDir(prefix: string): string {
		const directory = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		cleanups.push(() => {
			if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
		});
		return directory;
	}

	it("uses one Workspace for multiple Sessions and keeps them under that Workspace", () => {
		const root = createTempDir("myharness-workspace-session-model");
		const dataRoot = join(root, "data");
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "project");
		mkdirSync(workspaceRoot, { recursive: true });

		const first = SessionManager.create(workspaceRoot, undefined, { id: "session-a" }, { dataRoot, agentDir });
		const second = SessionManager.create(
			join(workspaceRoot, ".", "nested", ".."),
			undefined,
			{ id: "session-b" },
			{ dataRoot, agentDir },
		);

		expect(first.getWorkspaceId()).toBe(second.getWorkspaceId());
		expect(first.getSessionDir()).toBe(getSessionDir(dataRoot, first.getWorkspaceId()!, "session-a"));
		expect(second.getSessionDir()).toBe(getSessionDir(dataRoot, first.getWorkspaceId()!, "session-b"));
		expect(WorkspaceStore.create(agentDir, dataRoot).list()).toHaveLength(1);
		expect(existsSync(first.getSessionDir())).toBe(true);
		expect(existsSync(second.getSessionDir())).toBe(true);
	});

	it("does not register a Workspace while listing or opening a legacy Session", async () => {
		const root = createTempDir("myharness-workspace-read-only");
		const dataRoot = join(root, "data");
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "unregistered");
		mkdirSync(workspaceRoot, { recursive: true });

		expect(await SessionManager.list(workspaceRoot, undefined, undefined, { dataRoot, agentDir })).toEqual([]);
		expect(findWorkspaceDataContext(workspaceRoot, { dataRoot, agentDir })).toBeUndefined();

		const legacyPath = join(dataRoot, "sessions", "legacy.jsonl");
		mkdirSync(join(dataRoot, "sessions"), { recursive: true });
		writeFileSync(
			legacyPath,
			`${JSON.stringify({ type: "session", version: 3, id: "legacy-session", timestamp: new Date().toISOString(), cwd: workspaceRoot })}\n`,
		);
		const opened = SessionManager.open(legacyPath);
		expect(opened.getWorkspaceId()).toBeUndefined();
		expect(WorkspaceStore.create(agentDir, dataRoot).list()).toEqual([]);
	});

	it("archives only verified fixture roots, preserves their data, and is idempotent", () => {
		const dataRoot = createTempDir("myharness-registry-migration-data");
		const agentDir = join(dataRoot, "agent");
		const validRoot = createTempDir("myharness-runtime-suite");
		const unresolvedRoot = createTempDir("myharness-runtime-events");
		const store = WorkspaceStore.create(agentDir, dataRoot);
		const validWorkspace = store.ensureForPath(validRoot);
		const unresolvedWorkspace = store.ensureForPath(unresolvedRoot);

		const sessionPath = getSessionConversationPath(
			dataRoot,
			validWorkspace.workspaceId,
			"verified-session",
			"conversation.jsonl",
		);
		mkdirSync(
			join(dataRoot, "workspaces", validWorkspace.workspaceId, "sessions", "verified-session", "tool-results"),
			{
				recursive: true,
			},
		);
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "verified-session",
				timestamp: new Date().toISOString(),
				cwd: validRoot,
				workspaceId: validWorkspace.workspaceId,
			})}\n${JSON.stringify({ type: "tool_result", id: "tool-1" })}\n`,
		);
		const toolResultPath = join(
			dataRoot,
			"workspaces",
			validWorkspace.workspaceId,
			"sessions",
			"verified-session",
			"tool-results",
			"result.txt",
		);
		writeFileSync(toolResultPath, "preserve me\n");

		const unresolvedSessionDir = join(
			dataRoot,
			"workspaces",
			unresolvedWorkspace.workspaceId,
			"sessions",
			"unresolved-session",
			"conversation",
		);
		mkdirSync(unresolvedSessionDir, { recursive: true });
		writeFileSync(join(unresolvedSessionDir, "conversation.jsonl"), "not a session header\n");

		const first = migrateWorkspaceRegistry(dataRoot, { agentDir });
		expect(first.completed).toBe(true);
		expect(first.archivedWorkspaceIds).toEqual([validWorkspace.workspaceId]);
		expect(first.unresolvedWorkspaceIds).toEqual([unresolvedWorkspace.workspaceId]);
		expect(
			WorkspaceStore.create(agentDir, dataRoot)
				.list()
				.map((workspace) => workspace.workspaceId),
		).toEqual([unresolvedWorkspace.workspaceId]);
		expect(existsSync(sessionPath)).toBe(true);
		expect(readFileSync(toolResultPath, "utf8")).toBe("preserve me\n");
		expect(JSON.parse(readFileSync(getWorkspaceUnresolvedPath(dataRoot), "utf8")).workspaces).toHaveLength(1);
		expect(existsSync(getWorkspaceRegistryMigrationMarkerPath(dataRoot))).toBe(true);

		const second = migrateWorkspaceRegistry(dataRoot, { agentDir });
		expect(second).toEqual(first);
		expect(readFileSync(sessionPath, "utf8")).toContain("verified-session");
	});

	it("does not overwrite an unreadable archive or remove its active Workspace", () => {
		const dataRoot = createTempDir("myharness-registry-migration-invalid-archive");
		const agentDir = join(dataRoot, "agent");
		const fixtureRoot = createTempDir("myharness-runtime-suite");
		const workspace = WorkspaceStore.create(agentDir, dataRoot).ensureForPath(fixtureRoot);
		const archivePath = getWorkspaceUnresolvedPath(dataRoot);
		mkdirSync(dirname(archivePath), { recursive: true });
		writeFileSync(archivePath, '{"version":2,"workspaces":[null]}\n');

		const result = migrateWorkspaceRegistry(dataRoot, { agentDir });
		expect(result.completed).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(WorkspaceStore.create(agentDir, dataRoot).getById(workspace.workspaceId)).toBeDefined();
		expect(readFileSync(archivePath, "utf8")).toContain("null");
	});
});
