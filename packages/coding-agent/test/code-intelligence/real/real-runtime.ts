import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { ChangeStore } from "../../../src/changes/change-store.ts";
import { ChangeControl, documentVersionLookup } from "../../../src/changes/service.ts";
import type { CodeIntelligenceRoutingOptions } from "../../../src/symbols/index/router/types.ts";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { CodeIntelligenceRuntime } from "../../../src/symbols/runtime/runtime.ts";
import type { SymbolTarget } from "../../../src/symbols/types.ts";
import { writeTsLabProject } from "./ts-lab-project.ts";

export function createManagedLabRuntime(lab: { root: string; storeRoot: string }): CodeIntelligenceRuntime {
	const installationManager = new CodeIntelligenceInstallationManager({});
	return new CodeIntelligenceRuntime({
		workspaceRoot: lab.root,
		registry: installationManager.createInstalledLanguageServerRegistry(),
		installationManager,
		agentDir: lab.storeRoot,
	});
}

/** Return independent command outcomes and restore the injected consumer even when execution fails. */
export function runRestoredConsumerFault(
	lab: { readText(path: string): string; write(path: string, text: string): void },
	path: string,
	inject: (text: string) => string,
	execute: () => unknown,
): boolean[] {
	const original = lab.readText(path);
	const evidence: unknown[] = [];
	try {
		return [false, true, false].map((broken) => {
			const source = broken ? inject(original) : original;
			lab.write(path, source);
			try {
				const output = execute();
				evidence.push({
					injected: broken,
					source,
					passed: true,
					output: output === undefined ? "" : String(output),
				});
				return true;
			} catch (error) {
				const failure = error as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
				evidence.push({
					injected: broken,
					source,
					passed: false,
					status: failure.status,
					stdout: String(failure.stdout ?? ""),
					stderr: String(failure.stderr ?? ""),
					message: failure.message,
				});
				return false;
			}
		});
	} finally {
		lab.write(path, original);
		if (process.env.MYHARNESS_ARTIFACTS_DIR) {
			const directory = join(process.env.MYHARNESS_ARTIFACTS_DIR, "tests", "independent-acceptance");
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, `${path.replaceAll("/", "_")}-${randomUUID()}.json`),
				JSON.stringify({ path, evidence }, null, 2),
			);
		}
	}
}

export async function assertConsumerRename(
	runtime: CodeIntelligenceRuntime,
	storeRoot: string,
	path: string,
	line: number,
	character: number,
	definitionId: string,
	oldName: string,
	newName: string,
	consumer: string,
	unrelated: string,
) {
	const target = { type: "position" as const, path, position: { line, character } };
	const routing = { mode: "semantic" as const, definitionId, timeoutMs: 60000 };
	const references = (await runtime.router.findReferences(target, routing)).items.map((item) => item.location.path);
	expect(references).toContain(consumer);
	expect(references).not.toContain(unrelated);
	return applyRealRename(runtime, storeRoot, target, routing, oldName, newName);
}

export async function applyRealRename(
	runtime: CodeIntelligenceRuntime,
	storeRoot: string,
	target: SymbolTarget,
	routing: CodeIntelligenceRoutingOptions,
	oldName: string,
	newName: string,
) {
	const planned = (await runtime.router.rename(target, newName, routing)).items[0];
	if (!planned) throw new Error("Real language server returned no rename plan");
	const broker = new ChangeControl({ workspaceRoot: runtime.workspaceRoot, store: new ChangeStore(storeRoot) });
	const preview = await broker.previewWorkspaceEdit(planned.edit, {
		description: `Rename ${oldName} to ${newName}`,
		source: "rename",
		knownVersion: documentVersionLookup(planned.documentVersions, runtime.workspaceRoot),
		rename: { oldName, newName },
	});
	await broker.apply(preview.changeset.id, { origin: { kind: "refactor" } });
	await runtime.services.notifyCommitted?.(preview.changeset.files.map((file) => file.absolutePath));
	return preview;
}

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
