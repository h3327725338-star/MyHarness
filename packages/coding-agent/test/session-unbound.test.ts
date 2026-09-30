import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNBOUND_WORKSPACE_ID } from "../src/config/paths/index.ts";
import { WorkspaceStore } from "../src/data/workspace-store.ts";
import { SessionManager } from "../src/session/manager/index.ts";

describe("Sessions that belong to no Workspace", () => {
	let root: string;
	let dataRoot: string;
	let agentDir: string;
	let project: string;
	let previousDataRoot: string | undefined;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = join(tmpdir(), `myharness-unbound-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		dataRoot = join(root, "data");
		agentDir = join(root, "agent");
		project = join(root, "project");
		for (const dir of [dataRoot, agentDir, project]) mkdirSync(dir, { recursive: true });
		previousDataRoot = process.env.MYHARNESS_DATA_ROOT;
		previousAgentDir = process.env.MYHARNESS_CODING_AGENT_DIR;
		process.env.MYHARNESS_DATA_ROOT = dataRoot;
		process.env.MYHARNESS_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousDataRoot === undefined) delete process.env.MYHARNESS_DATA_ROOT;
		else process.env.MYHARNESS_DATA_ROOT = previousDataRoot;
		if (previousAgentDir === undefined) delete process.env.MYHARNESS_CODING_AGENT_DIR;
		else process.env.MYHARNESS_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	/** A session is only written to disk once it holds an assistant message. */
	function persist(session: SessionManager, text: string): string {
		session.appendMessage({ role: "user", content: text, timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const file = session.getSessionFile();
		if (!file) throw new Error("session was not persisted");
		return file;
	}

	const registry = () => WorkspaceStore.create(agentDir, dataRoot);

	it("creates a session in the reserved container without registering a Workspace", async () => {
		const session = SessionManager.createUnbound(project);
		const file = persist(session, "no workspace");

		expect(session.getWorkspaceId()).toBe(UNBOUND_WORKSPACE_ID);
		expect(session.isUnbound()).toBe(true);
		expect(file).toContain(join("workspaces", UNBOUND_WORKSPACE_ID, "sessions"));
		expect(session.getCwd()).toBe(project);
		// Nothing was registered, so nothing shows up as a Workspace.
		expect(registry().list()).toEqual([]);

		const listed = await SessionManager.listUnbound();
		expect(listed.map((info) => info.path)).toEqual([file]);
		expect(listed[0]?.firstMessage).toBe("no workspace");
		// It can be opened again and keeps working.
		const reopened = SessionManager.open(file);
		expect(reopened.isUnbound()).toBe(true);
		expect(reopened.getCwd()).toBe(project);
		expect(reopened.buildSessionContext().messages).toHaveLength(2);
	});

	it("keeps the next session of an unbound one unbound and never registers its folder", () => {
		const first = SessionManager.createUnbound(project);
		persist(first, "one");
		const next = SessionManager.createLike(first, project);
		expect(next.isUnbound()).toBe(true);
		expect(next.getCwd()).toBe(project);
		persist(next, "two");
		expect(registry().list()).toEqual([]);
	});

	it("turns the sessions of a removed Workspace into unbound ones without moving or deleting anything", async () => {
		const bound = SessionManager.create(project);
		const file = persist(bound, "belongs to the project");
		const workspace = registry().getByRootPath(project);
		expect(workspace).toBeDefined();
		expect(bound.isUnbound()).toBe(false);
		expect(await SessionManager.listUnbound()).toEqual([]);

		expect(registry().remove(workspace!.workspaceId)).toBe(true);

		// The project folder and the session file are where they were; only the mapping is gone.
		expect(existsSync(project)).toBe(true);
		expect(existsSync(file)).toBe(true);
		expect(SessionManager.open(file).isUnbound()).toBe(true);
		expect((await SessionManager.listUnbound()).map((info) => info.path)).toEqual([file]);
		expect((await SessionManager.listAll()).map((info) => info.path)).toContain(file);
		expect(await SessionManager.list(project)).toEqual([]);

		// A new session after it does not quietly register the old folder again.
		const next = SessionManager.createLike(SessionManager.open(file), project);
		expect(next.isUnbound()).toBe(true);
		persist(next, "still no workspace");
		expect(registry().list()).toEqual([]);

		// Adding the same folder again reattaches the sessions that stayed behind.
		const again = registry().add(project);
		expect(again.workspace?.workspaceId).toBe(workspace!.workspaceId);
		expect((await SessionManager.list(project)).map((info) => info.path)).toContain(file);
		expect((await SessionManager.listUnbound()).map((info) => info.path)).not.toContain(file);
	});

	it("keeps bound sessions bound when the next one is created", () => {
		const bound = SessionManager.create(project);
		persist(bound, "bound");
		const next = SessionManager.createLike(bound, project);
		expect(next.isUnbound()).toBe(false);
		expect(next.getWorkspaceId()).toBe(bound.getWorkspaceId());
	});
});
