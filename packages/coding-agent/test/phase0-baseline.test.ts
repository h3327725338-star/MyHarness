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
	it("keeps the package facade and Web artifact contract", () => {
		const packageJson = JSON.parse(readRepositoryFile("packages/coding-agent/package.json")) as {
			bin?: Record<string, string>;
			main?: string;
			types?: string;
			exports?: Record<string, Record<string, string>>;
		};
		expect(packageJson.bin?.myharness).toBe("dist/web.js");
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
			"runWebMode",
			"startWebBootstrap",
		]) {
			expect(facade, `public facade marker: ${marker}`).toContain(marker);
		}
	});

	it("starts from source with Node and the dev loader instead of browser launcher scripts", () => {
		for (const entry of ["packages/coding-agent/src/web.ts", "scripts/dev-fast-loader.mjs"]) {
			expect(existsSync(resolve(repositoryRoot, entry)), entry).toBe(true);
		}
		for (const removed of [
			"dev-web.cmd",
			"dev-web.ps1",
			"dev-web.vbs",
			"web-runtime.ps1",
			"web-source.ps1",
			"web-source.sh",
			"scripts/test-dev-launcher.ps1",
		]) {
			expect(existsSync(resolve(repositoryRoot, removed)), removed).toBe(false);
		}
		const desktopMain = normalizeSource(readRepositoryFile("packages/desktop/main.cjs"));
		expect(desktopMain).toContain("packages/coding-agent/src/web.ts");
		expect(desktopMain).toContain("scripts/dev-fast-loader.mjs");
		expect(desktopMain).toContain("'--no-open'");
		const copyLauncher = readRepositoryFile("packages/coding-agent/src/modes/web/worktree-launch.ts");
		expect(copyLauncher).toContain(
			'spawn(process.execPath, ["--import", pathToFileURL(loader).href, entry, "--port", "0"]',
		);
	});

	it("keeps the Bun binary entrypoint, build inputs, and adjacent asset layout", () => {
		const packageJson = JSON.parse(readRepositoryFile("packages/coding-agent/package.json")) as {
			scripts?: Record<string, string>;
		};
		const binaryBuild = packageJson.scripts?.["build:binary"] ?? "";
		expect(binaryBuild).toContain("bun build --compile ./dist/bun/web.js");
		expect(binaryBuild).toContain("./src/utils/image-resize-worker.ts");
		expect(binaryBuild).toContain("./src/utils/jxl-decode-worker.ts");
		expect(binaryBuild).toContain("--outfile dist/myharness");
		expect(packageJson.scripts?.["copy-binary-assets"]).toContain("../../system-prompts");

		const bunCli = readRepositoryFile("packages/coding-agent/src/bun/web.ts");
		expect(bunCli).toContain("registerBunOAuthFlows()");
		expect(bunCli).toContain("restoreSandboxEnv()");
		expect(bunCli).toContain('await import("./register-bedrock.ts")');
		expect(bunCli).toContain('await import("../web.ts")');

		const config = readRepositoryFile("packages/coding-agent/src/config.ts");
		expect(config).toContain("export const isBunBinary");
		expect(config).toContain('return join(getPackageDir(), "web")');
		expect(config).toContain('return join(getPackageDir(), "export-html")');
		expect(config).not.toContain("getInteractiveAssetsDir");
	});

	it("keeps the system-prompt lookup roots and composition entrypoints", () => {
		const loader = readRepositoryFile("packages/ai/src/api/system-prompt-loader.ts");
		expect(loader).toContain("MYHARNESS_SYSTEM_PROMPT_DIR");
		expect(loader).toContain('path.join(path.dirname(nodeProcess!.execPath), "system-prompts")');
		expect(loader).toContain('path.join(repoRoot, "system-prompts")');
		expect(loader).toContain('path.resolve(moduleDir, "../system-prompts")');

		// Built-in prompts live under system-prompts/common/; the loader keeps the logical
		// resource names ("global/core.md") and resolves them under `common`.
		expect(existsSync(resolve(repositoryRoot, "system-prompts/common/global/core.md"))).toBe(true);
		expect(existsSync(resolve(repositoryRoot, "system-prompts/common/global/output-language.md"))).toBe(true);

		const promptComposition = readRepositoryFile("packages/coding-agent/src/system-prompts/composer/index.ts");
		expect(promptComposition).toContain('loadSystemPrompt("global/core.md")');
		expect(promptComposition).toContain('loadSystemPrompt("session/working-directory.md"');
		expect(promptComposition).toContain("export function buildSystemPrompt");
	});
});
