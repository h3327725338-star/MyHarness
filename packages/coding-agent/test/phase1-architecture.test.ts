import { readFileSync } from "node:fs";
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

const directPresentationImport = /(?:from|import\()\s*["'][^"']*(?:myharness-tui|modes\/interactive)[^"']*["']/;
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

		const legacyRenderUtils = readRepositoryFile("packages/coding-agent/src/tools/render-utils.ts");
		expect(legacyRenderUtils).toContain("./presentation/render-utils.ts");
		expect(legacyRenderUtils).not.toMatch(directPresentationImport);
	});

	it("keeps built-in rendering behind the presentation registry", () => {
		const registry = readRepositoryFile("packages/coding-agent/src/tools/presentation/index.ts");
		for (const toolName of [
			"bash",
			"pwsh",
			"read",
			"write",
			"grep",
			"find",
			"ls",
			"edit",
			"symbols",
			"agent",
			"workflow",
			"ultracode",
		]) {
			expect(registry, `renderer registry entry: ${toolName}`).toContain(`${toolName}:`);
		}

		const interactiveToolExecution = readRepositoryFile(
			"packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
		);
		expect(interactiveToolExecution).toContain("getBuiltinToolRenderer");
		expect(interactiveToolExecution).toContain("builtinRenderer?.renderCall");
		expect(interactiveToolExecution).toContain("builtinRenderer?.renderResult");

		const htmlToolRenderer = readRepositoryFile("packages/coding-agent/src/exports/html/tool-renderer.ts");
		expect(htmlToolRenderer).toContain("getBuiltinToolRenderer");
	});

	it("keeps renderer callbacks on the public built-in tool definition API", () => {
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
			expect(typeof definition.renderCall, `${definition.name} call renderer`).toBe("function");
			expect(typeof definition.renderResult, `${definition.name} result renderer`).toBe("function");
		}
		expect(createEditToolDefinition(process.cwd()).renderShell).toBe("self");
	});

	it("keeps theme file parsing neutral until the interactive frontend creates a Theme", () => {
		const themeResource = readRepositoryFile("packages/coding-agent/src/themes/loader/theme-resource.ts");
		expect(themeResource).toContain("export interface ThemeResource");
		expect(themeResource).toContain("loadThemeResourceFromPath");
		expect(themeResource).not.toContain("myharness-tui");
		expect(themeResource).not.toContain("modes/interactive");

		const interactiveTheme = readRepositoryFile("packages/coding-agent/src/modes/interactive/theme/theme.ts");
		expect(interactiveTheme).toContain("createThemeFromResource");
	});
});
