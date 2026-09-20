import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");

function readRepositoryFile(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function normalizeSource(source: string): string {
	return source.replaceAll("\\", "/");
}

describe("Phase 0 compatibility contracts", () => {
	it("keeps the package facade and CLI artifact contract", () => {
		const packageJson = JSON.parse(readRepositoryFile("packages/coding-agent/package.json")) as {
			bin?: Record<string, string>;
			main?: string;
			types?: string;
			exports?: Record<string, Record<string, string>>;
		};
		expect(packageJson.bin?.myharness).toBe("dist/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.exports?.["."]?.import).toBe("./dist/index.js");
		expect(packageJson.exports?.["."]?.types).toBe("./dist/index.d.ts");

		const facade = readRepositoryFile("packages/coding-agent/src/index.ts");
		for (const marker of [
			"AgentSession",
			"createExtensionRuntime",
			"ModelRuntime",
			"SessionManager",
			"SettingsManager",
			"createAgentSession",
			"main",
			"InteractiveMode",
			"runPrintMode",
		]) {
			expect(facade, `public facade marker: ${marker}`).toContain(marker);
		}
	});

	it("keeps the Windows source startup chain and argument forwarding", () => {
		const devCmd = normalizeSource(readRepositoryFile("dev.cmd"));
		const devPs1 = normalizeSource(readRepositoryFile("dev.ps1"));
		const testPs1 = normalizeSource(readRepositoryFile("myharness-test.ps1"));

		expect(devCmd).toContain("-NoProfile -ExecutionPolicy Bypass -File");
		expect(devCmd).toContain("%SCRIPT_DIR%dev.ps1");
		expect(devCmd).toContain("%*");
		expect(devPs1).toContain('Join-Path $Root "myharness-test.ps1"');
		expect(devPs1).toContain("& $entryScript @args");
		expect(testPs1).toContain('Join-Path $scriptDir "node_modules/.bin/tsx.cmd"');
		expect(testPs1).toContain('Join-Path $scriptDir "packages/coding-agent/src/cli.ts"');
		expect(testPs1).toContain("& $tsxBin $cliPath @forwardArgs");
	});

	it("keeps the Bun binary entrypoint, build inputs, and adjacent asset layout", () => {
		const packageJson = JSON.parse(readRepositoryFile("packages/coding-agent/package.json")) as {
			scripts?: Record<string, string>;
		};
		const binaryBuild = packageJson.scripts?.["build:binary"] ?? "";
		expect(binaryBuild).toContain("bun build --compile ./dist/bun/cli.js");
		expect(binaryBuild).toContain("./src/utils/image-resize-worker.ts");
		expect(binaryBuild).toContain("./src/utils/jxl-decode-worker.ts");
		expect(binaryBuild).toContain("--outfile dist/myharness");
		expect(packageJson.scripts?.["copy-binary-assets"]).toContain("../../system-prompts");

		const bunCli = readRepositoryFile("packages/coding-agent/src/bun/cli.ts");
		expect(bunCli).toContain("registerBunOAuthFlows()");
		expect(bunCli).toContain("restoreSandboxEnv()");
		expect(bunCli).toContain('await import("./register-bedrock.ts")');
		expect(bunCli).toContain('await import("../cli.ts")');

		const config = readRepositoryFile("packages/coding-agent/src/config.ts");
		expect(config).toContain("export const isBunBinary");
		expect(config).toContain('return join(getPackageDir(), "theme")');
		expect(config).toContain('return join(getPackageDir(), "export-html")');
		expect(config).toContain('return join(getPackageDir(), "assets")');
	});

	it("keeps the system-prompt lookup roots and composition entrypoints", () => {
		const loader = readRepositoryFile("packages/ai/src/api/system-prompt-loader.ts");
		expect(loader).toContain("MYHARNESS_SYSTEM_PROMPT_DIR");
		expect(loader).toContain('path.join(path.dirname(nodeProcess!.execPath), "system-prompts")');
		expect(loader).toContain('path.join(repoRoot, "system-prompts")');
		expect(loader).toContain('path.resolve(moduleDir, "../system-prompts")');

		expect(existsSync(resolve(repositoryRoot, "system-prompts/global/core.md"))).toBe(true);
		expect(existsSync(resolve(repositoryRoot, "system-prompts/global/output-language.md"))).toBe(true);

		const promptComposition = readRepositoryFile("packages/coding-agent/src/system-prompts/composer/index.ts");
		expect(promptComposition).toContain('loadSystemPrompt("global/core.md")');
		expect(promptComposition).toContain('loadSystemPrompt("session/working-directory.md"');
		expect(promptComposition).toContain("export function buildSystemPrompt");
	});
});
