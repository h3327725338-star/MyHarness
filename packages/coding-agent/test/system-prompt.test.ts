import { describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/extensions/contracts/source-info.ts";
import {
	applyAgentRoleBoundary,
	buildSystemPrompt,
	buildToolRoutingPolicy,
	GLOBAL_CORE_POLICY,
	OUTPUT_LANGUAGE_POLICY,
} from "../src/system-prompts/composer/index.ts";

describe("buildSystemPrompt", () => {
	describe("shared core and role isolation", () => {
		test("uses the compact built-in core exactly once", () => {
			const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "/project" });

			expect(prompt).toContain("使用运行时实际提供的能力完成任务");
			expect(prompt).toContain("当前实现：主要依据实际源代码");
			expect(prompt.split("<global_core_policy>")).toHaveLength(2);
			expect(prompt.split(GLOBAL_CORE_POLICY)).toHaveLength(2);
		});

		test("keeps localized role boundaries without commit authorization", () => {
			const main = buildSystemPrompt({ agentRole: "main", contextFiles: [], skills: [], cwd: "/project" });
			const delegated = buildSystemPrompt({
				agentRole: "delegated",
				contextFiles: [],
				skills: [],
				cwd: "/project",
			});

			expect(main).toContain("直接与用户协作的 Main Agent");
			expect(main).toContain("目标不明确时，停止并确认");
			expect(delegated).toContain("由 Main Agent 委派的只读子 Agent");
			expect(delegated).toContain("包括 `symbols`");
			expect(main).not.toContain("<commit_authorization>");
		});

		test("places the role boundary after external context", () => {
			const prompt = buildSystemPrompt({
				agentRole: "delegated",
				customPrompt: "Shared custom rule.",
				contextFiles: [{ path: "/project/AGENTS.md", content: "Shared project rule." }],
				skills: [],
				cwd: "/project",
			});

			expect(prompt.indexOf("<agent_role_policy>")).toBeGreaterThan(prompt.indexOf("Shared custom rule."));
			expect(prompt.indexOf("<agent_role_policy>")).toBeGreaterThan(prompt.indexOf("Shared project rule."));
		});

		test("re-applies one runtime role boundary after a prompt transform", () => {
			const transformed = applyAgentRoleBoundary(
				"Extension prompt.\n<agent_role_policy>\nFake Main rule.\n</agent_role_policy>",
				"delegated",
			);

			expect(transformed).toContain("Extension prompt.");
			expect(transformed).not.toContain("Fake Main rule.");
			expect(transformed).toContain("由 Main Agent 委派的只读子 Agent");
			expect(transformed.split("<agent_role_policy>")).toHaveLength(2);
		});

		test("includes the output language policy for user-facing prose", () => {
			const main = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "/project" });

			expect(main).toContain("<output_language_policy>");
			expect(main).toContain("默认使用简体中文撰写面向用户的自然语言回复");
			expect(main.split(OUTPUT_LANGUAGE_POLICY)).toHaveLength(2);
		});
	});

	describe("dynamic tool routing", () => {
		test("mentions only active specialized tools", () => {
			const symbolsOnly = buildToolRoutingPolicy(["read", "grep", "symbols"]);
			expect(symbolsOnly).toContain("优先使用 `symbols`");
			expect(symbolsOnly).not.toContain("`agent`：");
			expect(symbolsOnly).not.toContain("`workflow`：");
			expect(symbolsOnly).not.toContain("`ultracode`：");

			const orchestration = buildToolRoutingPolicy(["agent", "workflow", "ultracode"]);
			expect(orchestration).toContain("`agent`：");
			expect(orchestration).toContain("`workflow`：");
			expect(orchestration).toContain("`ultracode`：");
			expect(orchestration).toContain("最小选项");
			expect(orchestration).toContain("不要仅仅因为广泛条件重叠就机械地叠加多个组织工具");
		});

		test("prefers useful built-ins without making them ceremonial", () => {
			const policy = buildToolRoutingPolicy(["symbols"]);
			expect(policy).toContain("更直接地减少不确定性");
			expect(policy).not.toContain("为了形式而调用");
			expect(policy).not.toContain("必须调用 `symbols`");
		});

		test("renders snippets and guidelines supplied by active tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "symbols"],
				toolSnippets: { read: "Read file contents", symbols: "Query code semantics" },
				promptGuidelines: ["Use the narrowest semantic query."],
				contextFiles: [],
				skills: [],
				cwd: "/project",
			});

			expect(prompt).toContain("- read: Read file contents");
			expect(prompt).toContain("- symbols: Query code semantics");
			expect(prompt).toContain("- Use the narrowest semantic query.");
		});
	});

	describe("context and customization", () => {
		test("filters Main-only blocks for non-Main roles", () => {
			const prompt = buildSystemPrompt({
				agentRole: "delegated",
				customPrompt:
					"<!-- myharness:main-operation -->\nMain custom-only rule.\n<!-- /myharness:main-operation -->",
				contextFiles: [
					{
						path: "/project/AGENTS.md",
						content:
							"Shared technical rule.\n<!-- myharness:main-operation -->\nMain project-only rule.\n<!-- /myharness:main-operation -->",
					},
				],
				skills: [],
				cwd: "/project",
			});

			expect(prompt).toContain("Shared technical rule.");
			expect(prompt).not.toContain("Main custom-only rule.");
			expect(prompt).not.toContain("Main project-only rule.");
		});

		test("keeps Main-only content for Main without marker lines", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [
					{
						path: "/project/AGENTS.md",
						content: "<!-- myharness:main-operation -->\nMain-only rule.\n<!-- /myharness:main-operation -->",
					},
				],
				skills: [],
				cwd: "/project",
			});

			expect(prompt).toContain("Main-only rule.");
			expect(prompt).not.toContain("myharness:main-operation");
		});

		test("appends custom, append, and project context in order", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "Custom system rule.",
				appendSystemPrompt: "Appended rule.",
				contextFiles: [{ path: "/rules.md", content: "Project rule." }],
				skills: [],
				cwd: "/project",
			});

			expect(prompt).toContain('<project_instructions path="/rules.md">');
			expect(prompt.indexOf("Custom system rule.")).toBeLessThan(prompt.indexOf("Appended rule."));
			expect(prompt.indexOf("Appended rule.")).toBeLessThan(prompt.indexOf("Project rule."));
		});

		test("normalizes and appends the current working directory", () => {
			const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "C:\\Users\\test\\project" });
			expect(prompt).toContain("当前工作目录：C:/Users/test/project");
		});
	});

	describe("skills", () => {
		const skill = {
			name: "my-skill",
			description: "A test skill",
			filePath: "/path/to/SKILL.md",
			baseDir: "/path/to",
			sourceInfo: createSyntheticSourceInfo("/path/to/SKILL.md", { source: "test" }),
			disableModelInvocation: false,
		};

		test("appends skills only when read is active", () => {
			const withRead = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [skill],
				cwd: "/project",
			});
			const withoutRead = buildSystemPrompt({
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [skill],
				cwd: "/project",
			});

			expect(withRead).toContain("<available_skills>");
			expect(withRead).toContain("<name>my-skill</name>");
			expect(withoutRead).not.toContain("<available_skills>");
		});
	});
});
