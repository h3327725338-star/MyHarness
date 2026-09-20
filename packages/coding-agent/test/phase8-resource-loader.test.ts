import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DefaultResourceLoader,
	loadProjectContextFiles as legacyLoadProjectContextFiles,
} from "../src/application/resource-loader.ts";
import { loadProjectContextFiles } from "../src/context/project-context-loader.ts";
import { discoverAppendSystemPromptFile, discoverSystemPromptFile } from "../src/system-prompts/loader/index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativePath: string): string {
	return readFileSync(join(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

describe("Phase 8 resource loader boundaries", () => {
	it("keeps dedicated loaders independent from the TUI and the public facade", () => {
		const dedicatedLoaders = [
			"packages/coding-agent/src/context/project-context-loader.ts",
			"packages/coding-agent/src/system-prompts/loader/index.ts",
			"packages/coding-agent/src/extensions/loader/resource-set.ts",
			"packages/coding-agent/src/skills/loader/index.ts",
			"packages/coding-agent/src/prompts/loader/index.ts",
			"packages/coding-agent/src/themes/loader/index.ts",
		];
		const forbiddenPresentationImport =
			/(?:from|import\()\s*["'][^"']*(?:frontend|modes\/interactive|myharness-tui)[^"']*["']/;

		for (const file of dedicatedLoaders) {
			expect(readSource(file), `${file} must not depend on frontend implementations`).not.toMatch(
				forbiddenPresentationImport,
			);
		}

		const resourceFacade = readSource("packages/coding-agent/src/application/resource-loader.ts");
		expect(resourceFacade).toContain("ExtensionResourceLoader");
		expect(resourceFacade).toContain("loadProjectContextFiles");
		expect(resourceFacade).toContain("loadThemeResources");
		expect(resourceFacade).toContain("discoverSystemPromptFile");
		expect(resourceFacade).not.toContain("loadExtensionsCached");
		expect(resourceFacade).not.toContain("loadExtensionFromFactory");
		expect(resourceFacade).not.toContain("loadThemeResourceFromPath");
		expect(resourceFacade).not.toContain("readdirSync");
		expect(resourceFacade).not.toMatch(forbiddenPresentationImport);
	});

	it("keeps the old project-context entry point as an exact compatibility export", () => {
		expect(legacyLoadProjectContextFiles).toBe(loadProjectContextFiles);
	});

	it("preserves project context order and trust-gated system prompt discovery", () => {
		const root = mkdtempSync(join(tmpdir(), "myharness-phase8-resource-loader-"));
		const agentDir = join(root, "agent");
		const projectRoot = join(root, "project");
		const cwd = join(projectRoot, "nested");
		try {
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(projectRoot, ".myharness"), { recursive: true });
			writeFileSync(join(agentDir, "AGENTS.md"), "global");
			writeFileSync(join(projectRoot, "AGENTS.md"), "parent");
			writeFileSync(join(cwd, "AGENTS.md"), "cwd");
			mkdirSync(join(cwd, ".myharness"), { recursive: true });
			writeFileSync(join(cwd, ".myharness", "SYSTEM.md"), "project system");
			writeFileSync(join(agentDir, "SYSTEM.md"), "global system");

			expect(loadProjectContextFiles({ cwd, agentDir }).map((file) => file.content)).toEqual([
				"global",
				"parent",
				"cwd",
			]);
			expect(discoverSystemPromptFile({ cwd, agentDir, projectTrusted: true })).toBe(
				join(cwd, ".myharness", "SYSTEM.md"),
			);
			expect(discoverSystemPromptFile({ cwd, agentDir, projectTrusted: false })).toBe(join(agentDir, "SYSTEM.md"));
			expect(discoverAppendSystemPromptFile({ cwd, agentDir, projectTrusted: false })).toBeUndefined();
		} finally {
			if (existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("keeps the legacy DefaultResourceLoader constructible", () => {
		const loader = new DefaultResourceLoader({ cwd: repositoryRoot, agentDir: join(repositoryRoot, "node_modules") });
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
	});
});
