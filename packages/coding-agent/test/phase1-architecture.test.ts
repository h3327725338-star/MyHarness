import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPwshToolDefinition,
	createReadToolDefinition,
	createSubAgentToolDefinition,
	createSymbolsToolDefinition,
	createWorkflowToolDefinition,
	createWriteToolDefinition,
} from "../src/index.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");

function readRepositoryFile(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

const businessFiles = [
	"packages/coding-agent/src/tools/shell/bash.ts",
	"packages/coding-agent/src/tools/shell/pwsh.ts",
	"packages/coding-agent/src/tools/files/read.ts",
	"packages/coding-agent/src/tools/files/write.ts",
	"packages/coding-agent/src/tools/files/grep.ts",
	"packages/coding-agent/src/tools/files/find.ts",
	"packages/coding-agent/src/tools/files/ls.ts",
	"packages/coding-agent/src/tools/files/edit.ts",
	"packages/coding-agent/src/tools/symbols.ts",
	"packages/coding-agent/src/tools/sub-agent.ts",
	"packages/coding-agent/src/workflow/engine.ts",
	"packages/coding-agent/src/tools/github/tool.ts",
	"packages/coding-agent/src/tools/registry.ts",
	"packages/coding-agent/src/tools/contracts/index.ts",
	"packages/coding-agent/src/application/resource-loader.ts",
	"packages/coding-agent/src/themes/loader/theme-resource.ts",
];

const directPresentationImport =
	/(?:from|import\()\s*["'][^"']*(?:@myharness\/tui|myharness-tui|modes\/interactive)[^"']*["']/;
const rendererMember = /\brender(?:Call|Result|Shell)\b/;

describe("Phase 1 architecture boundaries", () => {
	it("keeps business tools and resource loading independent from the TUI", () => {
		for (const file of businessFiles) {
			const source = readRepositoryFile(file);
			expect(source, `${file} must not import TUI or interactive modules`).not.toMatch(directPresentationImport);
		}

		for (const file of businessFiles.filter(
			(file) => !file.endsWith("resource-loader.ts") && !file.endsWith("theme-resource.ts"),
		)) {
			const source = readRepositoryFile(file);
			expect(source, `${file} must not own renderer members`).not.toMatch(rendererMember);
		}

		const contract = readRepositoryFile("packages/coding-agent/src/tools/contracts/index.ts");
		expect(contract).not.toMatch(rendererMember);

		expect(existsSync(resolve(repositoryRoot, "packages/coding-agent/src/tools/render-utils.ts"))).toBe(false);
	});

	it("keeps HTML export independent of terminal rendering", () => {
		const exporter = readRepositoryFile("packages/coding-agent/src/exports/html/session-export.ts");
		expect(exporter).not.toMatch(directPresentationImport);
		expect(exporter).not.toContain("createToolHtmlRenderer");
		expect(existsSync(resolve(repositoryRoot, "packages/coding-agent/src/exports/html/tool-renderer.ts"))).toBe(
			false,
		);
	});

	it("exposes UI-neutral public built-in tool definitions", () => {
		const definitions = [
			createBashToolDefinition(process.cwd()),
			createPwshToolDefinition(process.cwd()),
			createReadToolDefinition(process.cwd()),
			createWriteToolDefinition(process.cwd()),
			createGrepToolDefinition(process.cwd()),
			createFindToolDefinition(process.cwd()),
			createLsToolDefinition(process.cwd()),
			createEditToolDefinition(process.cwd()),
			createSymbolsToolDefinition(process.cwd()),
			createSubAgentToolDefinition(process.cwd()),
			createWorkflowToolDefinition(process.cwd()),
		];

		for (const definition of definitions) {
			expect(definition).not.toHaveProperty("renderCall");
			expect(definition).not.toHaveProperty("renderResult");
		}
		expect(createEditToolDefinition(process.cwd())).not.toHaveProperty("renderShell");
	});

	it("keeps theme file parsing neutral until the interactive frontend creates a Theme", () => {
		const themeResource = readRepositoryFile("packages/coding-agent/src/themes/loader/theme-resource.ts");
		expect(themeResource).toContain("export interface ThemeResource");
		expect(themeResource).toContain("loadThemeResourceFromPath");
		expect(themeResource).not.toContain("myharness-tui");
		expect(themeResource).not.toContain("modes/interactive");

		expect(existsSync(resolve(repositoryRoot, "packages/coding-agent/src/modes/interactive/theme/theme.ts"))).toBe(
			false,
		);
	});
});
