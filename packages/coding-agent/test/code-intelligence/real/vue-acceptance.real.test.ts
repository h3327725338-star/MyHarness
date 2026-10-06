import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageServerManager } from "../../../src/symbols/lsp/language-server/manager.ts";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { CodeIntelligenceRuntime } from "../../../src/symbols/runtime/runtime.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { applyRealRename } from "./real-runtime.ts";

const installation = new CodeIntelligenceInstallationManager({});
const registry = installation.createInstalledLanguageServerRegistry();
const vue = registry?.getAll().find((server) => server.id === "managed-vue");
afterEach(disposeTestWorkspaces);

describe.skipIf(!vue)("real Vue script semantic bridge", () => {
	it("renames an unopened imported consumer, keeps same-name objects and detects downstream compile errors", async () => {
		const lab = createTestWorkspace({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
				include: ["*.ts", "*.vue"],
			}),
			"util.ts": "export function twice(value: number): number { return value * 2; }\n",
			"Sample.vue":
				'<script setup lang="ts">\nimport { twice } from "./util";\nconst answer = twice(21);\n</script>\n<template>{{ answer }}</template>\n',
			"consumer.ts": 'import { twice } from "./util";\nexport const answer = twice(10);\n',
			"other.ts": "export function twice(value: string): string { return value; }\n",
		});
		const runtime = new CodeIntelligenceRuntime({
			workspaceRoot: lab.root,
			registry,
			installationManager: installation,
			agentDir: lab.storeRoot,
			languageServerManager: new LanguageServerManager({
				registry,
				logger: (entry) => {
					if (entry.category === "stderr") console.error(entry);
				},
			}),
		});
		try {
			const target = { type: "position" as const, path: "Sample.vue", position: { line: 2, character: 16 } };
			const routing = { mode: "semantic" as const, definitionId: "managed-vue", timeoutMs: 60000 };
			const references = await runtime.router.findReferences(target, routing);
			expect(references.items.map((item) => item.location.path)).toContain("consumer.ts");
			expect(references.items.map((item) => item.location.path)).not.toContain("other.ts");
			const definition = await runtime.router.findDefinition(target, routing);
			expect(definition.items[0]?.path, JSON.stringify(definition)).toBe("util.ts");
			expect((await runtime.router.hover(target, routing)).items.length).toBe(1);
			const preview = await applyRealRename(runtime, lab.storeRoot, target, routing, "twice", "double");
			expect(preview.changeset.files.map((file) => file.path)).toEqual(["Sample.vue", "consumer.ts", "util.ts"]);
			expect(lab.readText("Sample.vue")).toContain("double(21)");
			expect(lab.readText("consumer.ts")).toContain("double(10)");
			expect(lab.readText("other.ts")).toContain("function twice");
			const compilerRoot = vue?.env?.MYHARNESS_CODE_INTELLIGENCE_ROOT;
			if (!compilerRoot) throw new Error("Managed Vue compiler root missing");
			const compile = () =>
				execFileSync(
					process.execPath,
					[
						join(compilerRoot, "node_modules/typescript/lib/tsc.js"),
						"--noEmit",
						"--project",
						lab.abs("tsconfig.json"),
					],
					{ cwd: lab.root, encoding: "utf8", stdio: "pipe", windowsHide: true },
				);
			// Independent TS compiler checks the unopened TS consumer; this is not a Vue template typecheck.
			expect(compile).not.toThrow();
			const consumer = lab.readText("consumer.ts");
			lab.write("consumer.ts", consumer.replace("double(10)", 'double("wrong")'));
			expect(compile).toThrow();
			lab.write("consumer.ts", consumer);
			expect(compile).not.toThrow();
			const component = lab.readText("Sample.vue");
			lab.write("Sample.vue", component.replace("double(21)", 'double("invalid")'));
			const broken = await runtime.router.getDiagnostics("Sample.vue", routing);
			expect(
				broken.items.some((item) => item.code === "2345"),
				JSON.stringify(broken),
			).toBe(true);
			lab.write("Sample.vue", component.replace("double(21)", "double(21"));
			expect(
				(await runtime.router.getDiagnostics("Sample.vue", routing)).items.some(
					(item) => item.severity === "error",
				),
			).toBe(true);
			lab.write("Sample.vue", component);
			expect(
				(await runtime.router.getDiagnostics("Sample.vue", routing)).items.some((item) => item.code === "2345"),
			).toBe(false);
		} finally {
			await runtime.dispose();
		}
	}, 120000);
});
