import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_MEMORY_SYSTEM_PROMPT } from "../src/agent/runtime/auto-memory.ts";
import { getAgentRolePrompt } from "../src/agent/runtime/role.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { buildSystemPrompt } from "../src/system-prompts/composer/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * Prompt cache stability tests.
 *
 * DeepSeek context caching matches the request prefix. The system prompt is
 * the longest stable prefix, so it must stay byte-identical across turns when
 * nothing real changed (tools, context files, settings). Dynamic content such
 * as recalled memory belongs in the message list, not in the system prompt.
 */
describe("prompt cache stability", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		delete process.env[ENV_AGENT_DIR];
	});

	const autoMemorySettings = {
		enabled: true,
		provider: "openai",
		model: "gpt-test",
		thinkingLevel: "high",
	} as const;

	async function createMemoryHarness(): Promise<Harness> {
		const harness = await createHarness({
			persisted: true,
			settings: { autoMemory: autoMemorySettings },
		});
		// AutoMemoryManager 通过 getAgentDir()（环境变量优先）定位 memory 根目录，
		// 而不是 harness.tempDir。显式指向 harness 的 agent 目录，保证测试写入的
		// 内存文件能被 recall 读到，且不依赖开发者机器上的真实用户目录（CI 上没有）。
		process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
		harnesses.push(harness);
		return harness;
	}

	function writeGlobalMemory(harness: Harness, name: string, content: string): void {
		const memoryDir = join(harness.tempDir, "agent", "memory", "global");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(
			join(memoryDir, `${name}.md`),
			[
				"---",
				`id: global/${name}`,
				`name: ${name}`,
				"description: 处理代码任务时相关",
				"type: feedback",
				"scope: global",
				"createdAt: 2025-01-01T00:00:00.000Z",
				"updatedAt: 2025-01-01T00:00:00.000Z",
				"---",
				content,
				"",
			].join("\n"),
			"utf8",
		);
	}

	describe("Test 1: base system prompt stability", () => {
		it("builds byte-identical prompts for identical configuration", () => {
			const options = {
				cwd: "/project",
				contextFiles: [{ path: "/project/AGENTS.md", content: "rule" }],
				skills: [],
				selectedTools: ["read", "bash", "edit", "write"],
				toolSnippets: { read: "Read", bash: "Bash", edit: "Edit", write: "Write" },
				promptGuidelines: ["guideline"],
			};
			expect(buildSystemPrompt(options)).toBe(buildSystemPrompt(options));
		});
	});

	describe("Test 2/3: Auto Memory enabled", () => {
		it("keeps the memory policy in the system prompt with and without a recall", async () => {
			const harness = await createMemoryHarness();

			// Turn 1: no memory files exist, so no recall happens.
			harness.setResponses([fauxAssistantMessage("reply 1")]);
			await harness.session.prompt("你好");
			const systemPromptWithoutRecall = harness.session.systemPrompt;
			expect(systemPromptWithoutRecall).toContain(AUTO_MEMORY_SYSTEM_PROMPT);
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "auto-memory-recall",
				),
			).toBe(false);

			// Turn 2: a matching memory now exists, so recall succeeds.
			writeGlobalMemory(harness, "source-first", "处理代码任务时要先检查真实源码，再依据代码得出结论。");
			harness.setResponses([fauxAssistantMessage("reply 2")]);
			await harness.session.prompt("检查真实源码");
			const systemPromptWithRecall = harness.session.systemPrompt;
			expect(systemPromptWithRecall).toContain(AUTO_MEMORY_SYSTEM_PROMPT);
			expect(
				harness.session.messages.some(
					(message) => message.role === "custom" && message.customType === "auto-memory-recall",
				),
			).toBe(true);

			// The system prompt must be byte-identical across turns even though
			// the recalled memory message appeared only in turn 2.
			expect(systemPromptWithRecall).toBe(systemPromptWithoutRecall);
		});
	});

	describe("Test 4: Auto Memory disabled", () => {
		it("does not include the memory policy in the system prompt", async () => {
			const harness = await createHarness({ persisted: true });
			harnesses.push(harness);

			harness.setResponses([fauxAssistantMessage("reply")]);
			await harness.session.prompt("你好");

			expect(harness.session.systemPrompt).not.toContain(AUTO_MEMORY_SYSTEM_PROMPT);
		});
	});

	describe("Test 5: Main Agent role", () => {
		it("keeps the main role and task boundary", () => {
			const mainPrompt = getAgentRolePrompt("main");
			expect(mainPrompt).toContain("直接与用户协作的 Main Agent");
			expect(mainPrompt).toContain("不要自行扩大任务范围");
		});
	});

	describe("Test 6: Delegated Agent role", () => {
		it("keeps the delegated agent within its read-only role", () => {
			const delegatedPrompt = getAgentRolePrompt("delegated");
			expect(delegatedPrompt).toContain("由 Main Agent 委派的只读子 Agent");
			expect(delegatedPrompt).toContain("包括 `symbols`");
		});
	});

	describe("Test 7: deduplicated rules keep their semantics", () => {
		it("keeps each rule class exactly once in the final main system prompt", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: "/project",
			});

			const baseRule = "当前实现：主要依据实际源代码";
			const scopeRule = "不要自行扩大任务范围";
			expect(prompt.split(baseRule).length - 1).toBe(1);
			expect(prompt.split(scopeRule).length - 1).toBe(1);
		});
	});
});
