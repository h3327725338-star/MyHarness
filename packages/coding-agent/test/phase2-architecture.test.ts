import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");

function readRepositoryFile(relativePath: string): string {
	return readFileSync(resolve(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

describe("Phase 2 architecture boundaries", () => {
	it("keeps Extension contracts lightweight and presentation-free", () => {
		const contractFiles = [
			"packages/coding-agent/src/extensions/contracts/tool.ts",
			"packages/coding-agent/src/extensions/contracts/events.ts",
			"packages/coding-agent/src/extensions/contracts/registration.ts",
			"packages/coding-agent/src/extensions/contracts/ui.ts",
			"packages/coding-agent/src/extensions/contracts/index.ts",
		];
		const forbiddenContractImport =
			/(?:from|import\()\s*["'][^"']*(?:src\/core\/|modes\/interactive|myharness-tui|theme\/theme)[^"']*["']/;

		for (const file of contractFiles) {
			expect(readRepositoryFile(file), `${file} must not depend on concrete runtime layers`).not.toMatch(
				forbiddenContractImport,
			);
		}

		const toolContract = readRepositoryFile("packages/coding-agent/src/extensions/contracts/tool.ts");
		expect(toolContract).not.toMatch(/render(Call|Result|Shell)/);
		expect(toolContract).toContain("ctx: TContext");

		const uiContract = readRepositoryFile("packages/coding-agent/src/extensions/contracts/ui.ts");
		expect(uiContract).toContain("ExtensionUIContextPort");
		expect(uiContract).not.toContain("Component");
	});

	it("routes loading through the dedicated Extension API Entry", () => {
		const loader = readRepositoryFile("packages/coding-agent/src/extensions/loader/index.ts");
		const apiEntry = readRepositoryFile("packages/coding-agent/src/extensions/api-entry.ts");
		const publicFacade = readRepositoryFile("packages/coding-agent/src/index.ts");

		expect(loader).toContain("../api-entry.ts");
		expect(loader).not.toContain('"../../index.ts"');
		expect(loader).not.toContain("packageIndex");
		expect(apiEntry).toContain("Runtime entry made available to loaded extensions");
		expect(apiEntry).not.toContain('"../index.ts"');
		expect(publicFacade).toContain('"./extensions/compat/index.ts"');

		for (const legacySpecifier of ["@mariozechner/pi-coding-agent", "@myharness/coding-agent"]) {
			expect(loader, `legacy alias ${legacySpecifier}`).toContain(legacySpecifier);
		}
	});

	it("loads the dedicated Extension API Entry without the public facade", async () => {
		const apiEntry = await import("../src/extensions/api-entry.ts");

		expect(typeof apiEntry.getAgentDir).toBe("function");
		expect(typeof apiEntry.defineTool).toBe("function");
		expect(typeof apiEntry.createReadTool).toBe("function");
		expect(apiEntry).not.toHaveProperty("BorderedLoader");
		expect(typeof apiEntry.SessionManager).toBe("function");
	});

	it("keeps Tools and internal modules off the Extension public barrel", () => {
		const publicFacade = readRepositoryFile("packages/coding-agent/src/index.ts");
		const toolSource = readRepositoryFile("packages/coding-agent/src/tools/tool-definition-wrapper.ts");
		const toolPresentationTypes = readRepositoryFile("packages/coding-agent/src/tools/presentation/public.ts");
		expect(toolSource).toContain("../extensions/contracts/tool.ts");
		expect(toolSource).not.toContain("extensions/types.ts");
		expect(toolSource).not.toContain("extensions/index.ts");
		expect(toolPresentationTypes).not.toContain("extensions/types.ts");
		expect(toolPresentationTypes).not.toContain("extensions/index.ts");

		expect(publicFacade).not.toContain("./core/");
	});
});
