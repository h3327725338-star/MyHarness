import { describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/extensions/contracts/source-info.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/startup/slash-commands.ts";
import {
	applyAgentRoleBoundary,
	buildSystemPrompt,
	buildToolRoutingPolicy,
	formatSlashCommandsForPrompt,
	GLOBAL_CORE_POLICY,
	OUTPUT_LANGUAGE_POLICY,
} from "../src/system-prompts/composer/index.ts";
import { loadSystemPrompt, loadSystemPromptLines } from "../src/system-prompts/loader/index.ts";

describe("buildSystemPrompt", () => {
	describe("shared core and role isolation", () => {
		test("uses the compact built-in core exactly once", () => {
			const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "/project" });

			expect(prompt).toContain("Complete tasks using capabilities actually provided by the runtime");
			expect(prompt).toContain("Current implementation: rely primarily on actual source code");
			expect(prompt.split("<global_core_policy>")).toHaveLength(2);
			expect(prompt.split(GLOBAL_CORE_POLICY)).toHaveLength(2);
		});

		test("keeps role boundaries without commit authorization", () => {
			const main = buildSystemPrompt({ agentRole: "main", contextFiles: [], skills: [], cwd: "/project" });
			const delegated = buildSystemPrompt({
				agentRole: "delegated",
				contextFiles: [],
				skills: [],
				cwd: "/project",
			});

			expect(main).toContain("Main Agent working directly with the user");
			expect(main).toContain("Stop and confirm if the target is unclear");
			expect(delegated).toContain("read-only sub-Agent delegated by the Main Agent");
			expect(delegated).toContain("read-only investigation capabilities actually provided by the runtime");
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
			expect(transformed).toContain("read-only sub-Agent delegated by the Main Agent");
			expect(transformed.split("<agent_role_policy>")).toHaveLength(2);
		});

		test("includes the output language policy for user-facing prose", () => {
			const main = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "/project" });

			expect(main).toContain("<output_language_policy>");
			expect(main).toContain("By default, match and respond in the language used by the user");
			expect(main.split(OUTPUT_LANGUAGE_POLICY)).toHaveLength(2);
		});
	});

	describe("dynamic tool routing", () => {
		test("omits symbols from complete main, delegated, and Explore prompts when it is off by default", () => {
			const common = { contextFiles: [], skills: [], cwd: "/project" };
			const delegatedTools = ["read", "grep", "find", "ls", "bash"];
			const delegatedSnippets = Object.fromEntries(
				delegatedTools.map((name) => [name, loadSystemPrompt(`tools/${name}/snippet.md`)]),
			);
			const prompts = [
				buildSystemPrompt(common),
				buildSystemPrompt({
					...common,
					agentRole: "delegated",
					selectedTools: delegatedTools,
					toolSnippets: delegatedSnippets,
				}),
				buildSystemPrompt({
					...common,
					agentRole: "delegated",
					selectedTools: delegatedTools,
					toolSnippets: delegatedSnippets,
					appendSystemPrompt: loadSystemPrompt("roles/explore.md"),
				}),
			];

			for (const prompt of prompts) expect(prompt.toLowerCase()).not.toContain("symbols");
		});

		test("includes the symbols tool text only when it is active and has no retired index wording", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "symbols"],
				toolSnippets: {
					read: loadSystemPrompt("tools/read/snippet.md"),
					symbols: loadSystemPrompt("tools/symbols/snippet.md"),
				},
				promptGuidelines: loadSystemPromptLines("tools/symbols/guidelines.md"),
				contextFiles: [],
				skills: [],
				cwd: "/project",
			});

			expect(prompt.toLowerCase()).toContain("symbols");
			expect(prompt).toContain("Query code structure with explicit source and completeness");
			expect(prompt.toLowerCase()).not.toContain("lightweight");
			expect(prompt).toContain("semantic versus lexical evidence");
		});

		test("mentions only active specialized tools", () => {
			const symbolsOnly = buildToolRoutingPolicy(["read", "grep", "symbols"]);
			expect(symbolsOnly).toContain("Choose symbols when structure helps");
			expect(symbolsOnly).not.toContain("agent: use");
			expect(symbolsOnly).not.toContain("workflow: use");
			expect(symbolsOnly).not.toContain("ultracode: use");

			const orchestration = buildToolRoutingPolicy(["agent", "workflow", "ultracode"]);
			expect(orchestration).toContain("agent: use");
			expect(orchestration).toContain("workflow: use");
			expect(orchestration).toContain("ultracode: use");
			expect(orchestration).toContain("smallest investigation option");
			expect(orchestration).toContain("do not mechanically combine multiple orchestration tools");
		});

		test("prefers useful built-ins without making them ceremonial", () => {
			const policy = buildToolRoutingPolicy(["symbols"]);
			expect(policy).toContain("more directly reduces uncertainty");
			expect(policy).not.toContain("for ceremony");
			expect(policy).not.toContain("must call symbols");
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
			expect(prompt).toContain("Current working directory: C:/Users/test/project");
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

	describe("slash command grounding", () => {
		test("injects the real command list with a no-invention rule", () => {
			const prompt = buildSystemPrompt({ contextFiles: [], skills: [], cwd: "/project" });
			expect(prompt).toContain("<available_slash_commands>");
			expect(prompt).toContain("- /model:");
			// Every registered builtin command is listed, so the model only recommends real ones.
			for (const command of BUILTIN_SLASH_COMMANDS) {
				expect(prompt).toContain(`- /${command.name}`);
			}
			expect(prompt).toContain("Only ever recommend a slash command from this list");
			expect(formatSlashCommandsForPrompt()).toContain("- /settings (alias /setting):");
		});
	});
});
