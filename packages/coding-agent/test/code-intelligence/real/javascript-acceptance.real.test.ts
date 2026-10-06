import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { assertConsumerRename, createManagedLabRuntime, runRestoredConsumerFault } from "./real-runtime.ts";

const installed = new CodeIntelligenceInstallationManager({}).createInstalledLanguageServerRegistry();
afterEach(disposeTestWorkspaces);
it.skipIf(!installed?.getAll().some((entry) => entry.languages.includes("javascript")))(
	"JavaScript renames unopened alias consumers and preserves re-export behavior independently under Node",
	async () => {
		const lab = createTestWorkspace({
			"package.json": '{"type":"module"}',
			"jsconfig.json":
				'{"compilerOptions":{"checkJs":true,"module":"nodenext","target":"es2022"},"include":["*.js"]}',
			"maths.js":
				'export function twice(value) { if (typeof value !== "number") throw new TypeError("number required"); return value * 2; }\n',
			"index.js": 'export { twice as calculate } from "./maths.js";\n',
			"consumer.js":
				'import { calculate } from "./index.js";\nif (calculate(21) !== 42) throw new Error("wrong result");\n',
			"direct.js": 'import { twice as alias } from "./maths.js";\nexport const result = alias(21);\n',
			"other.js": "export function twice(value) { return String(value); }\n",
		});
		const runtime = createManagedLabRuntime(lab);
		try {
			const server = installed!.getAll().find((entry) => entry.languages.includes("javascript"))!;
			await assertConsumerRename(
				runtime,
				lab.storeRoot,
				"maths.js",
				0,
				18,
				server.id,
				"twice",
				"double",
				"direct.js",
				"other.js",
			);
			expect(lab.readText("index.js")).toContain("double as calculate");
			expect(lab.readText("direct.js")).toContain("double as alias");
			expect(lab.readText("consumer.js")).toContain("calculate(21)");
			expect(lab.readText("other.js")).toContain("function twice");
			const outcomes = runRestoredConsumerFault(
				lab,
				"consumer.js",
				(text) => text.replace("calculate(21)", 'calculate("bad")'),
				() =>
					execFileSync(process.execPath, [lab.abs("consumer.js")], {
						cwd: lab.root,
						encoding: "utf8",
						stdio: "pipe",
						windowsHide: true,
					}),
			);
			expect(outcomes).toEqual([true, false, true]);
		} finally {
			await runtime.dispose();
		}
	},
	120000,
);
