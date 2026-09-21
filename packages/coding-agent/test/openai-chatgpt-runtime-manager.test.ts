import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAIChatGPTRuntimeManager } from "../src/providers/openai-chatgpt/runtime-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenAI ChatGPT runtime manager", () => {
	it("keeps runtime state, CODEX_HOME, and session sandboxes provider-scoped", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "myharness-openai-chatgpt-runtime-"));
		temporaryDirectories.push(agentDir);
		const manager = new OpenAIChatGPTRuntimeManager({
			agentDir: join(agentDir, "agent data", "代理"),
			executablePath: process.execPath,
			install: false,
		});

		const first = await manager.ensureSessionDirectories("session/one");
		const second = await manager.ensureSessionDirectories("session/two");

		expect(await manager.resolveExecutablePath()).toBe(resolve(process.execPath));
		expect(first.codexHome).toBe(manager.getCodexHome());
		expect(first.sandbox).not.toBe(second.sandbox);
		expect(first.runtimeState).not.toBe(second.runtimeState);
		expect(first.sandbox.startsWith(manager.getSandboxRoot())).toBe(true);
		expect(first.runtimeState.startsWith(manager.getRuntimeStateRoot())).toBe(true);
		expect(first.sandbox).not.toContain(process.cwd());
		expect(first.codexHome).not.toBe(process.env.CODEX_HOME);
		const managedConfig = await readFile(join(first.codexHome, "config.toml"), "utf8");
		expect(managedConfig).toContain('default_permissions = "myharness_openai_chatgpt"');
		expect(managedConfig).toContain('":root" = "deny"');
		expect(managedConfig).toContain('[permissions.myharness_openai_chatgpt.filesystem.":workspace_roots"]');
	});

	it("does not allow a session id to escape the managed sandbox root", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "myharness-openai-chatgpt-runtime-"));
		temporaryDirectories.push(agentDir);
		const manager = new OpenAIChatGPTRuntimeManager({ agentDir, executablePath: process.execPath, install: false });
		const directories = manager.getSessionDirectories("../../outside/代理");

		expect(resolve(directories.sandbox).startsWith(resolve(manager.getSandboxRoot()))).toBe(true);
		expect(resolve(directories.runtimeState).startsWith(resolve(manager.getRuntimeStateRoot()))).toBe(true);
	});
});
