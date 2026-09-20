import { describe, expect, it, vi } from "vitest";
import {
	createReadOnlyGuardExtensionSource,
	hasHardAutoReviewBashCommand,
	hasUnsafeAutoReviewOutputRedirection,
	hasUnsafeDelegatedBashCommand,
	isAutoReviewAiAdjudicationCandidate,
	isAutoReviewValidationCommand,
} from "../src/tools/shell/read-only-guard.ts";

describe("delegated read-only bash guard", () => {
	it("allows output redirection to the null device and temp directories, and blocks project writes", () => {
		expect(hasUnsafeAutoReviewOutputRedirection("node --version 2>&1")).toBe(false);
		expect(hasUnsafeAutoReviewOutputRedirection('node -e "console.log(value => value.id)"')).toBe(false);
		expect(hasUnsafeAutoReviewOutputRedirection("git diff 2>/dev/null")).toBe(false);
		expect(hasUnsafeAutoReviewOutputRedirection("echo probe > /tmp/probe.txt")).toBe(false);
		expect(hasUnsafeAutoReviewOutputRedirection("echo probe > $TMPDIR/probe.txt")).toBe(false);
		expect(hasUnsafeAutoReviewOutputRedirection("echo changed > src/a.ts")).toBe(true);
		expect(hasUnsafeAutoReviewOutputRedirection("echo changed >> src/a.ts")).toBe(true);
	});

	it("generates a guard that blocks project mutations and dependency/git writes but allows temp scripts", async () => {
		const source = createReadOnlyGuardExtensionSource("blocked");
		expect(source).not.toContain("__name");
		const createExtension = new Function(
			source.replace("export default function (pi) {", "return function (pi) {"),
		) as () => (pi: { on: (event: string, handler: (input: unknown) => unknown) => void }) => void;
		let handler: ((event: { toolName: string; input: { command: string } }) => Promise<unknown>) | undefined;
		createExtension()({
			on: (_event, registered) => {
				handler = registered as typeof handler;
			},
		});

		expect(await handler?.({ toolName: "bash", input: { command: "git diff -- src/a.ts" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: "ls -la" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: "git status --short" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: "npm test" } })).toEqual({
			block: true,
			reason: "blocked",
		});
		expect(await handler?.({ toolName: "bash", input: { command: "echo probe > /tmp/probe.txt" } })).toEqual({
			block: true,
			reason: "blocked",
		});
		expect(await handler?.({ toolName: "bash", input: { command: "rm src/a.ts" } })).toEqual({
			block: true,
			reason: "blocked",
		});
		expect(await handler?.({ toolName: "bash", input: { command: "git add src/a.ts" } })).toEqual({
			block: true,
			reason: "blocked",
		});
		expect(await handler?.({ toolName: "bash", input: { command: "npm install foo" } })).toEqual({
			block: true,
			reason: "blocked",
		});
	});

	it("stops allowing bash after the configured command limit", async () => {
		const source = createReadOnlyGuardExtensionSource("blocked", { maxBashCommands: 2 });
		const createExtension = new Function(
			source.replace("export default function (pi) {", "return function (pi) {"),
		) as () => (pi: { on: (event: string, handler: (input: unknown) => unknown) => void }) => void;
		let handler: ((event: { toolName: string; input: { command: string } }) => Promise<unknown>) | undefined;
		createExtension()({
			on: (_event, registered) => {
				handler = registered as typeof handler;
			},
		});

		expect(await handler?.({ toolName: "bash", input: { command: "git status --short" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: "git diff -- src/a.ts" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: "git status --short" } })).toEqual({
			block: true,
			reason: "已到达 Bash 命令数量上限。",
		});
	});

	it("uses a strict read-only command boundary for delegated Bash", () => {
		expect(hasUnsafeDelegatedBashCommand("git status --short")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("git -C packages diff -- src/a.ts")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand('rg "agent,role" packages')).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("grep -E 'tsgo|biome|esbuild' package.json")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("Get-ChildItem packages -Recurse")).toBe(false);

		expect(hasUnsafeDelegatedBashCommand("python -c \"open('src/a.ts', 'w').write('x')\"")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("node -e \"require('fs').writeFileSync('src/a.ts', 'x')\"")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand('bash -c "echo changed > src/a.ts"')).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("git fetch origin")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("find . -exec rm {} +")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("find . -delete")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("sort -o src/a.ts src/b.ts")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("echo changed > src/a.ts")).toBe(true);
	});

	it("allows only read-only branch and tag listings", () => {
		expect(hasUnsafeDelegatedBashCommand("git branch")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("git branch --show-current")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("git branch -a")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("git tag --list")).toBe(false);
		expect(hasUnsafeDelegatedBashCommand("git tag -l")).toBe(false);

		expect(hasUnsafeDelegatedBashCommand("git branch new-review-branch")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("git branch -m old-name new-name")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("git branch -f new-review-branch")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("git tag new-review-tag")).toBe(true);
		expect(hasUnsafeDelegatedBashCommand("git tag --delete old-tag")).toBe(true);
	});

	it("recognizes real validation commands instead of validation words", () => {
		expect(isAutoReviewValidationCommand("npm test")).toBe(true);
		expect(isAutoReviewValidationCommand("npm.cmd test")).toBe(true);
		expect(isAutoReviewValidationCommand("npm run typecheck")).toBe(true);
		expect(isAutoReviewValidationCommand("npm run check:ts-imports")).toBe(true);
		expect(isAutoReviewValidationCommand("npm run check:browser-smoke")).toBe(true);
		expect(isAutoReviewValidationCommand("tsgo --noEmit")).toBe(true);
		expect(isAutoReviewValidationCommand("tsgo.cmd --noEmit")).toBe(true);
		expect(isAutoReviewValidationCommand("biome check .")).toBe(true);
		expect(isAutoReviewValidationCommand("eslint packages/coding-agent/src")).toBe(true);
		expect(isAutoReviewValidationCommand("prettier --check .")).toBe(true);
		expect(isAutoReviewValidationCommand("node --check packages/coding-agent/src/cli.ts")).toBe(true);

		expect(isAutoReviewValidationCommand("git grep test")).toBe(false);
		expect(isAutoReviewValidationCommand("cat test-results.txt")).toBe(false);
		expect(isAutoReviewValidationCommand("grep lint README.md")).toBe(false);
		expect(isAutoReviewValidationCommand("npm run build")).toBe(false);
		expect(isAutoReviewValidationCommand("npm run check")).toBe(false);
		expect(isAutoReviewValidationCommand("npm test --config test.config.js")).toBe(false);
		expect(isAutoReviewValidationCommand("tsgo --noEmit false")).toBe(false);
		expect(isAutoReviewValidationCommand("biome check --write .")).toBe(false);
		expect(isAutoReviewValidationCommand("npm test && echo passed")).toBe(false);
	});

	it("uses the AI adjudicator only for soft-blocked read-only candidates", async () => {
		const command =
			'ls -la .myharness/ 2>/dev/null; echo "---git---"; ls .myharness/git/ 2>/dev/null; find . -name "*.bak" -o -name "*.orig" 2>/dev/null | grep -i auto | head';
		const moduleInspectionCommand = `node --input-type=module -e "import m from './sample.js'; console.log(m)"`;
		const namedModuleInspectionCommand = `node --input-type=module -e 'import { extractDelegatedMessageToolEvidence } from "./dist/agent/delegation/event-parser.js"; console.log(extractDelegatedMessageToolEvidence([]))'`;
		expect(hasHardAutoReviewBashCommand('echo "rm"')).toBe(false);
		expect(isAutoReviewAiAdjudicationCandidate('echo "rm"')).toBe(true);
		expect(hasHardAutoReviewBashCommand("rm src/a.ts")).toBe(true);
		expect(hasHardAutoReviewBashCommand(command)).toBe(false);
		expect(isAutoReviewAiAdjudicationCandidate(command)).toBe(true);
		expect(hasHardAutoReviewBashCommand(moduleInspectionCommand)).toBe(false);
		expect(isAutoReviewAiAdjudicationCandidate(moduleInspectionCommand)).toBe(true);
		expect(isAutoReviewAiAdjudicationCandidate(`node --version && ${moduleInspectionCommand}`)).toBe(true);
		expect(hasHardAutoReviewBashCommand(namedModuleInspectionCommand)).toBe(false);
		expect(isAutoReviewAiAdjudicationCandidate(namedModuleInspectionCommand)).toBe(true);
		expect(isAutoReviewAiAdjudicationCandidate('node -e "console.log(1)"')).toBe(false);
		expect(
			isAutoReviewAiAdjudicationCandidate(
				`node --input-type=module -e "import m from './sample.js'; console.log(m); writeFileSync('x', 'y')"`,
			),
		).toBe(false);

		const source = createReadOnlyGuardExtensionSource("delegated blocked", {
			mode: "delegated",
			adjudicator: { provider: "deepseek", model: "deepseek-v4-flash", timeoutMs: 1_000, maxCalls: 3 },
		});
		const createExtension = new Function(
			source.replace("export default function (pi) {", "return function (pi) {"),
		) as () => (pi: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) => void;
		let handler:
			| ((
					event: { toolName: string; input: { command: string } },
					ctx: {
						modelRegistry: {
							find: () => { api: string; baseUrl: string };
							getApiKeyAndHeaders: () => Promise<{ ok: true; apiKey: string; headers: Record<string, string> }>;
						};
						signal?: AbortSignal;
					},
			  ) => Promise<unknown>)
			| undefined;
		createExtension()({
			on: (_event, registered) => {
				handler = registered as typeof handler;
			},
		});
		let aiDecision: "readonly" | "deny" = "readonly";
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
			void _url;
			void _init;
			return {
				ok: true,
				json: async () => ({
					choices: [
						{
							message: {
								content: JSON.stringify({
									decision: aiDecision,
									confidence: 0.99,
									reason: "只读检查和输出过滤",
								}),
							},
						},
					],
				}),
			} as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		const context = {
			modelRegistry: {
				find: () => ({ api: "openai-completions", baseUrl: "https://api.deepseek.com" }),
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
			},
		};

		try {
			expect(await handler?.({ toolName: "bash", input: { command: "ls -la" } }, context)).toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
			const adjudicationResult = await handler?.({ toolName: "bash", input: { command } }, context);
			expect(adjudicationResult).toBeUndefined();
			expect(fetchMock).toHaveBeenCalledOnce();
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(request.model).toBe("deepseek-v4-flash");
			expect(JSON.parse(request.messages[1].content)).toMatchObject({ command });
			expect(JSON.parse(request.messages[1].content).workingDirectory).toBe(process.cwd());
			expect(request).not.toHaveProperty("apiKey");
			expect(
				await handler?.({ toolName: "bash", input: { command: moduleInspectionCommand } }, context),
			).toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(await handler?.({ toolName: "bash", input: { command: "rm src/a.ts" } }, context)).toEqual({
				block: true,
				reason: "delegated blocked",
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
			aiDecision = "deny";
			expect(
				await handler?.(
					{ toolName: "bash", input: { command: 'find . -name "*.bak" -o -name "*.orig"' } },
					context,
				),
			).toEqual({
				block: true,
				reason: "delegated blocked",
			});
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("embeds the delegated Bash boundary in the child guard extension", async () => {
		const source = createReadOnlyGuardExtensionSource("delegated blocked", { mode: "delegated" });
		const createExtension = new Function(
			source.replace("export default function (pi) {", "return function (pi) {"),
		) as () => (pi: { on: (event: string, handler: (input: unknown) => unknown) => void }) => void;
		let handler: ((event: { toolName: string; input: { command: string } }) => Promise<unknown>) | undefined;
		createExtension()({
			on: (_event, registered) => {
				handler = registered as typeof handler;
			},
		});

		expect(await handler?.({ toolName: "bash", input: { command: "git status --short" } })).toBeUndefined();
		expect(await handler?.({ toolName: "bash", input: { command: 'python -c "print(1)"' } })).toEqual({
			block: true,
			reason: "delegated blocked",
		});
	});
});
