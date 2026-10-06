import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { CodeIntelligenceRuntime } from "../../../src/symbols/runtime/runtime.ts";
import { writeTsLabProject } from "./ts-lab-project.ts";

/**
 * Real language-server tests run against the machine's installed Code Intelligence modules. They are
 * reported separately from the mock tests and skip themselves where no TypeScript server is installed,
 * so a machine without modules shows "skipped", never "passed".
 */
function installedRegistry() {
	return new CodeIntelligenceInstallationManager({}).createInstalledLanguageServerRegistry({}, undefined);
}

export function realTypeScriptServerAvailable(): boolean {
	const registry = installedRegistry();
	return registry?.getAll().some((definition) => definition.languages.includes("typescript")) ?? false;
}

export interface RealTsLab {
	readonly root: string;
	readonly runtime: CodeIntelligenceRuntime;
	dispose(): Promise<void>;
}

/** An isolated copy of the TypeScript sample project with the real installed language servers behind it. */
export async function createRealTsLab(extraFiles: Readonly<Record<string, string>> = {}): Promise<RealTsLab> {
	const root = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-real-ts-lab-"));
	writeTsLabProject(root, extraFiles);
	const installation = new CodeIntelligenceInstallationManager({});
	const registry = installation.createInstalledLanguageServerRegistry({}, undefined);
	const runtime = new CodeIntelligenceRuntime({ workspaceRoot: root, registry, installationManager: installation });
	return {
		root,
		runtime,
		async dispose() {
			await runtime.dispose().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
