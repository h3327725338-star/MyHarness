import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionConversationPath, getSessionDir, getSessionMetadataPath } from "../src/config/paths/index.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { migrateSessionsToDataFramework } from "../src/session/migrations/data-framework.ts";

describe("Data Framework Session migration", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});

	function createRoot(): string {
		const root = join(tmpdir(), `myharness-data-framework-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		roots.push(root);
		return root;
	}

	it("moves sessions into stable Workspace/Session scopes and rewrites references", () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "project");
		const sourceDirectory = join(dataRoot, "sessions", "--legacy-project--");
		mkdirSync(workspaceRoot, { recursive: true });
		const parentSource = join(sourceDirectory, "2026-09-18T10-00-00-000Z_parent.jsonl");
		const childSource = join(sourceDirectory, "2026-09-18T10-01-00-000Z_child.jsonl");
		const outputSource = join(sourceDirectory, "tool-results", "child-session", "output.txt");
		mkdirSync(join(sourceDirectory, "tool-results", "child-session"), { recursive: true });
		writeFileSync(
			parentSource,
			`${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-18T10:00:00.000Z", cwd: workspaceRoot })}\n`,
		);
		writeFileSync(
			childSource,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: "2026-09-18T10:01:00.000Z",
					cwd: workspaceRoot,
					parentSession: parentSource,
				}),
				JSON.stringify({ type: "tool_result", details: { fullOutputPath: outputSource } }),
				"",
			].join("\n"),
		);
		writeFileSync(outputSource, "full output\n");

		const result = migrateSessionsToDataFramework(root, { dataRoot, agentDir });
		const workspace = WorkspaceStore.create(agentDir, dataRoot).getByRootPath(workspaceRoot);
		expect(workspace).toBeDefined();
		expect(result.errors).toEqual([]);
		expect(result.conflicts).toEqual([]);
		expect(result.unresolvedReferences).toEqual([]);
		expect(result.removedSourceFiles).toBe(3);
		expect(existsSync(parentSource)).toBe(false);
		expect(existsSync(childSource)).toBe(false);
		expect(existsSync(outputSource)).toBe(false);

		const targetParent = getSessionConversationPath(
			dataRoot,
			workspace!.workspaceId,
			"parent-session",
			"2026-09-18T10-00-00-000Z_parent.jsonl",
		);
		const targetChild = getSessionConversationPath(
			dataRoot,
			workspace!.workspaceId,
			"child-session",
			"2026-09-18T10-01-00-000Z_child.jsonl",
		);
		const targetOutput = join(
			getSessionDir(dataRoot, workspace!.workspaceId, "child-session"),
			"tool-results",
			"child-session",
			"output.txt",
		);
		expect(existsSync(targetParent)).toBe(true);
		expect(existsSync(targetChild)).toBe(true);
		expect(existsSync(targetOutput)).toBe(true);
		expect(existsSync(getSessionMetadataPath(dataRoot, workspace!.workspaceId, "parent-session"))).toBe(true);
		expect(existsSync(getSessionMetadataPath(dataRoot, workspace!.workspaceId, "child-session"))).toBe(true);
		const childLines = readFileSync(targetChild, "utf8").trim().split("\n");
		const childHeader = JSON.parse(childLines[0]!) as { id?: string; workspaceId?: string; parentSession?: string };
		const childEntry = JSON.parse(childLines[1]!) as { details?: { fullOutputPath?: string } };
		expect(childHeader.id).toBe("child-session");
		expect(childHeader.workspaceId).toBe(workspace!.workspaceId);
		expect(childHeader.parentSession).toBe(targetParent);
		expect(childEntry.details?.fullOutputPath).toBe(targetOutput);
		expect(existsSync(join(dataRoot, "workspaces", ".session-data-framework-migrated.json"))).toBe(true);

		const secondRun = migrateSessionsToDataFramework(root, { dataRoot, agentDir });
		expect(secondRun.migratedFiles).toBe(0);
		expect(secondRun.errors).toEqual([]);
	});

	it("keeps Workspace identity stable when its root is relocated", () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "before");
		const relocatedRoot = join(root, "after");
		mkdirSync(workspaceRoot, { recursive: true });

		const store = WorkspaceStore.create(agentDir, dataRoot);
		const workspace = store.ensureForPath(workspaceRoot);
		const result = store.relocateUnderRoot(workspaceRoot, relocatedRoot);

		expect(result.ok).toBe(true);
		expect(result.workspaces?.[0]?.workspaceId).toBe(workspace.workspaceId);
		expect(WorkspaceStore.create(agentDir, dataRoot).getByRootPath(relocatedRoot)?.workspaceId).toBe(
			workspace.workspaceId,
		);
	});

	it("keeps the source when a valid target contains different data", () => {
		const root = createRoot();
		const dataRoot = join(root, "data");
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "project");
		mkdirSync(workspaceRoot, { recursive: true });
		const sourceFile = join(dataRoot, "sessions", "--legacy-project--", "2026-09-18T10-00-00-000Z_session.jsonl");
		mkdirSync(join(dataRoot, "sessions", "--legacy-project--"), { recursive: true });
		writeFileSync(
			sourceFile,
			`${JSON.stringify({ type: "session", version: 3, id: "conflict-session", timestamp: "2026-09-18T10:00:00.000Z", cwd: workspaceRoot })}\n`,
		);
		const workspace = WorkspaceStore.create(agentDir, dataRoot).ensureForPath(workspaceRoot);
		const targetFile = getSessionConversationPath(
			dataRoot,
			workspace.workspaceId,
			"conflict-session",
			"2026-09-18T10-00-00-000Z_session.jsonl",
		);
		mkdirSync(join(dataRoot, "workspaces", workspace.workspaceId, "sessions", "conflict-session", "conversation"), {
			recursive: true,
		});
		writeFileSync(targetFile, "different target\n");

		const result = migrateSessionsToDataFramework(root, { dataRoot, agentDir });
		expect(result.conflicts).toContain(targetFile);
		expect(existsSync(sourceFile)).toBe(true);
		expect(readFileSync(targetFile, "utf8")).toBe("different target\n");
	});
});
