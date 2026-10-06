import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { applyRealRename, createManagedLabRuntime, runRestoredConsumerFault } from "./real-runtime.ts";

const registry = new CodeIntelligenceInstallationManager({}).createInstalledLanguageServerRegistry();
const server = registry?.getAll().find((entry) => entry.id === "managed-svelte");
afterEach(disposeTestWorkspaces);
describe.skipIf(!server)("real Svelte compiler acceptance", () => {
	it("renames an imported local alias without changing the TS export and detects malformed component markup", async () => {
		const lab = createTestWorkspace({
			"tsconfig.json":
				'{"compilerOptions":{"allowJs":true,"strict":true,"moduleResolution":"Bundler","module":"ESNext","target":"ES2022"}}',
			"maths.ts": "export function twice(value: number): number { return value * 2; }\n",
			"App.svelte":
				'<script lang="ts">\nimport {twice} from "./maths";\nconst answer = twice(21);\n</script>\n<p>{answer}</p>\n',
		});
		const runtime = createManagedLabRuntime(lab);
		try {
			const routing = { mode: "semantic" as const, definitionId: "managed-svelte", timeoutMs: 60000 };
			const target = { type: "position" as const, path: "App.svelte", position: { line: 2, character: 17 } };
			const definition = await runtime.router.findDefinition(target, routing);
			expect(definition.items.map((item) => item.path)).toContain("maths.ts");
			const before = lab.readText("maths.ts");
			const preview = await applyRealRename(runtime, lab.storeRoot, target, routing, "twice", "double");
			expect(preview.changeset.files.map((file) => file.path)).toEqual(["App.svelte"]);
			expect(lab.readText("App.svelte")).toContain("twice as double");
			expect(lab.readText("App.svelte")).toContain("double(21)");
			expect(lab.readText("maths.ts")).toBe(before);
			const root = server?.env?.MYHARNESS_CODE_INTELLIGENCE_ROOT;
			if (!root) throw new Error("Managed Svelte compiler runtime missing");
			const compilerPath = createRequire(join(root, "package.json")).resolve("svelte/compiler");
			const compiler = createRequire(import.meta.url)(compilerPath) as {
				compile(source: string, options: { filename: string }): unknown;
			};
			expect(
				runRestoredConsumerFault(
					lab,
					"App.svelte",
					(text) => text.replace("</p>", "</div>"),
					() => {
						// This fixture has no TypeScript-only script syntax; Svelte 4 expects preprocessing of lang="ts".
						compiler.compile(lab.readText("App.svelte").replace('<script lang="ts">', "<script>"), {
							filename: lab.abs("App.svelte"),
						});
					},
				),
			).toEqual([true, false, true]);
		} finally {
			await runtime.dispose();
		}
	}, 120000);
});
