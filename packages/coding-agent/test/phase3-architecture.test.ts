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

	it("keeps InteractiveMode on the presentation side of extracted workflows", () => {
		const source = readRepositoryFile("packages/coding-agent/src/modes/interactive/interactive-mode.ts");
		expect(source).toContain("application/use-cases/git-commit.ts");
		expect(source).toContain("application/use-cases/provider-settings.ts");
		expect(source).toContain("application/use-cases/workspace-session.ts");
		for (const implementationImport of [
			"generateCommitMessageForPathsAsync",
			"createGitCommitForPathsAsync",
			"getGitWorkingTreePathsAsync",
			"getGitCheckpointPendingTaskPathsAsync",
		]) {
			expect(source, `${implementationImport} must stay in the Git use case`).not.toContain(implementationImport);
		}
	});
});
