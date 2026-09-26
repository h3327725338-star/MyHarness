import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@myharness/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/runtime/sdk.ts";
import { DefaultResourceLoader } from "../src/application/resource-loader.ts";
import { SettingsManager } from "../src/config/settings/index.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";
import { SessionManager } from "../src/session/manager/index.ts";
import { registerManualTestProvider } from "./model-runtime-test-utils.ts";

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			modelRuntime: await createManualModelRuntime(agentDir),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");
		expect(session.getActiveToolNames()).toContain("github");
		expect(session.systemPrompt).toContain("- github:");

		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const dynamicTool = allTools.find((tool) => tool.name === "dynamic_tool");
		const readTool = allTools.find((tool) => tool.name === "read");

		expect(allTools.map((tool) => tool.name)).toContain("dynamic_tool");
		expect(dynamicTool?.promptGuidelines).toEqual([
			"Use dynamic_tool when the user asks for dynamic behavior tests.",
		]);
		expect(dynamicTool?.sourceInfo).toMatchObject({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		});
		expect(readTool?.sourceInfo).toMatchObject({
			path: "<builtin:read>",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- Use dynamic_tool when the user asks for dynamic behavior tests.");

		session.dispose();
	});

	it("exposes web tools only while Web Search is enabled", async () => {
		const settingsManager = SettingsManager.inMemory({ webSearch: { enabled: false } });
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			modelRuntime: await createManualModelRuntime(agentDir),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toEqual(
			expect.arrayContaining(["web_search", "web_fetch"]),
		);
		expect(session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		expect(session.systemPrompt).not.toContain("- web_search:");

		settingsManager.setWebSearchSettings({ enabled: true });
		session.refreshToolsAfterSettingsChange();
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["web_search", "web_fetch"]),
		);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		expect(session.systemPrompt).toContain("- web_search:");

		settingsManager.setWebSearchSettings({ enabled: false });
		session.refreshToolsAfterSettingsChange();
		expect(session.getAllTools().map((tool) => tool.name)).not.toEqual(
			expect.arrayContaining(["web_search", "web_fetch"]),
		);
		expect(session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		expect(session.systemPrompt).not.toContain("- web_search:");

		session.dispose();
	});

	it("returns source metadata for SDK custom tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			modelRuntime: await createManualModelRuntime(agentDir),
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		const sdkTool = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(sdkTool?.sourceInfo).toMatchObject({
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("sdk_tool");

		session.dispose();
	});

	it("keeps custom tools active but omits them from available tools when promptSnippet is not provided", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "hidden_tool",
							label: "Hidden Tool",
							description: "Description should not appear in available tools",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			modelRuntime: await createManualModelRuntime(agentDir),
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getActiveToolNames()).toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("Description should not appear in available tools");

		session.dispose();
	});

	async function createManualModelRuntime(runtimeAgentDir: string): Promise<ModelRuntime> {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const runtime = await ModelRuntime.create({
			authPath: join(runtimeAgentDir, "auth.json"),
			modelsPath: join(runtimeAgentDir, "models.json"),
		});
		registerManualTestProvider(runtime, model);
		return runtime;
	}
});
