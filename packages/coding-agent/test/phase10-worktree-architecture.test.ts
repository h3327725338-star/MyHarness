import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativePath: string): string {
	return readFileSync(join(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

function sourceFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...sourceFiles(fullPath));
		else if (/\.(?:ts|tsx)$/.test(entry.name)) result.push(fullPath);
	}
	return result;
}

describe("Phase 10 Worktree boundaries", () => {
	it("keeps Worktree logic in the Git product module", () => {
		const manager = readSource("packages/coding-agent/src/git/worktrees/manager.ts");
		const useCase = readSource("packages/coding-agent/src/application/use-cases/git-worktree.ts");
		expect(manager).not.toMatch(/(?:frontend|modes\/interactive|myharness-tui)/);
		expect(useCase).not.toMatch(/(?:frontend|modes\/interactive|myharness-tui)/);
		expect(manager).toContain('"worktree"');
		expect(manager).toContain('"merge"');
	});

	it("does not let the formal Worktree module route through the public facade", () => {
		const files = sourceFiles(join(repositoryRoot, "packages/coding-agent/src/git/worktrees"));
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(/from ["'][^"']*\/index\.ts["']/);
			expect(source, file).not.toMatch(/from ["'][^"']*\/src\/index\.ts["']/);
		}
	});
});
