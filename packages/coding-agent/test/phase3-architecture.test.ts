import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");

function readRepositoryFile(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

const noFrontendDependency = /(?:from|import\()\s*["'][^"']*(?:modes\/interactive|myharness-tui)[^"']*["']/;

describe("Phase 3 architecture boundaries", () => {
	it("keeps AgentSession coordinators and application use cases independent from the frontend", () => {
		const files = [
			"packages/coding-agent/src/context/coordinator.ts",
			"packages/coding-agent/src/git/checkpoints/coordinator.ts",
			"packages/coding-agent/src/observability/session-trace.ts",
			"packages/coding-agent/src/providers/recovery/coordinator.ts",
			"packages/coding-agent/src/application/use-cases/git-commit.ts",
			"packages/coding-agent/src/application/use-cases/provider-settings.ts",
			"packages/coding-agent/src/application/use-cases/workspace-session.ts",
		];

		for (const file of files) {
			expect(readRepositoryFile(file), `${file} must not depend on frontend implementations`).not.toMatch(
				noFrontendDependency,
			);
		}
	});

	it("keeps AgentSession as a lifecycle coordinator instead of the owner of extracted state machines", () => {
		const source = readRepositoryFile("packages/coding-agent/src/agent/runtime/agent-session.ts");

		expect(source).toContain("AgentSessionContextCoordinator");
		expect(source).toContain("AgentSessionGitCheckpointCoordinator");
		expect(source).toContain("AgentSessionTraceCoordinator");
		expect(source).toContain("ProviderRecoveryCoordinator");
		expect(source).not.toMatch(/private _recovery(?:Conversation|Budget|UsedInConversation)/);
		expect(source).not.toMatch(/private _lastBudgetCheck/);
		expect(source).not.toMatch(/private _trace(?:Run|ToolStarts|ModelRequests)/);
	});

	it("keeps Web routes on the presentation side of workflows", () => {
		const source = readRepositoryFile("packages/coding-agent/src/modes/web/routes-git.ts");
		expect(source).toContain("application/use-cases/git-commit.ts");
		expect(source).toContain("application/use-cases/git-push.ts");
	});

	it("keeps the session-scoped domain modules independent from the frontend", () => {
		const files = [
			"packages/coding-agent/src/agent/runtime/run-state.ts",
			"packages/coding-agent/src/agent/delegation/background-work.ts",
			"packages/coding-agent/src/context/compact/session-compaction.ts",
			"packages/coding-agent/src/context/compact/tree-navigation.ts",
			"packages/coding-agent/src/extensions/runtime/agent-events.ts",
			"packages/coding-agent/src/providers/runtime/request-auth.ts",
			"packages/coding-agent/src/providers/runtime/session-model.ts",
			"packages/coding-agent/src/tools/session-tool-registry.ts",
			"packages/coding-agent/src/tools/shell/session-bash.ts",
			"packages/coding-agent/src/application/use-cases/git-workspace.ts",
			"packages/coding-agent/src/application/use-cases/local-git-repository.ts",
			"packages/coding-agent/src/application/use-cases/conversation-title.ts",
		];

		for (const file of files) {
			expect(readRepositoryFile(file), `${file} must not depend on frontend implementations`).not.toMatch(
				noFrontendDependency,
			);
		}
	});

	it("keeps AgentSession delegating domain work to the modules that own it", () => {
		const source = readRepositoryFile("packages/coding-agent/src/agent/runtime/agent-session.ts");

		for (const owner of [
			"RunStateTracker",
			"SessionBackgroundWork",
			"SessionToolRegistry",
			"SessionModelController",
			"SessionCompactionRunner",
			"SessionBashRunner",
			"ExtensionAgentEventForwarder",
			"navigateSessionTree",
		]) {
			expect(source, `AgentSession must use ${owner}`).toContain(owner);
		}
		for (const implementationImport of [
			// tool registry assembly
			"createAllToolDefinitions",
			"wrapRegisteredTools",
			"createWebSearchService",
			// compaction and branch summaries
			"prepareCompaction",
			"generateBranchSummary",
			// direct Bash execution
			"executeBashWithOperations",
			// provider configuration reload
			"resetApiProviders",
			"clearApiKeyCache",
		]) {
			expect(source, `${implementationImport} must stay in its domain module`).not.toContain(implementationImport);
		}
		expect(source).not.toMatch(/private _(?:toolRegistry|toolDefinitions|baseToolDefinitions|scopedModels)\b/);
		expect(source).not.toMatch(/private _(?:backgroundExploreTasks|workflowControls|pendingBashMessages)\b/);
	});

	it("keeps Web dialogs independent from terminal components", () => {
		expect(readRepositoryFile("packages/coding-agent/src/modes/web/dialogs.ts")).not.toMatch(noFrontendDependency);
	});
});
