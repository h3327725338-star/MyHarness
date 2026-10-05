import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getModel } from "@myharness/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { getDataDir, getSessionDir, getWorkspaceSessionsDir } from "../src/config/paths/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { getDefaultSessionDirPath } from "../src/session/storage/jsonl/index.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let persistedSessionDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (persistedSessionDir && existsSync(persistedSessionDir)) {
			rmSync(persistedSessionDir, { recursive: true, force: true });
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the project data root for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const workspaceId = session.sessionManager.getWorkspaceId();
		expect(workspaceId).toBeTruthy();
		const expectedWorkspaceSessionsDir = getWorkspaceSessionsDir(getDataDir(), workspaceId!);
		const expectedSessionDir = getSessionDir(getDataDir(), workspaceId!, session.sessionManager.getSessionId());
		persistedSessionDir = expectedSessionDir;
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(getDefaultSessionDirPath(cwd)).toBe(expectedWorkspaceSessionsDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}${sep}`)).toBe(true);
		expect(sessionFile).toContain(`${sep}conversation${sep}`);
		expect(session.sessionManager.getDataRoot()).toBe(getDataDir());

		session.dispose();
	});

	it("uses an explicit dataRoot for the default SessionManager", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const dataRoot = join(tempDir, "isolated-data");

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			dataRoot,
			model: model!,
		});

		expect(session.sessionManager.getDataRoot()).toBe(dataRoot);
		expect(session.sessionManager.getSessionDir().startsWith(join(dataRoot, "workspaces"))).toBe(true);
		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd.replace(/\\/g, "/")}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `"${process.execPath}" -p "process.cwd()"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});
