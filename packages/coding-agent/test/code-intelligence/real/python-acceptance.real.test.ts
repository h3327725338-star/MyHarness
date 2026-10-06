import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { assertConsumerRename, createManagedLabRuntime, runRestoredConsumerFault } from "./real-runtime.ts";

const available = new CodeIntelligenceInstallationManager({})
	.createInstalledLanguageServerRegistry()
	?.getAll()
	.some((item) => item.id === "managed-python");
afterEach(disposeTestWorkspaces);
describe.skipIf(!available)("real Python acceptance", () => {
	it("preserves import aliases and detects independently executed consumer errors", async () => {
		const lab = createTestWorkspace({
			"pyrightconfig.json": '{"typeCheckingMode":"strict","include":["*.py"]}',
			"maths.py": "def twice(value: int) -> int:\n    return value * 2\n",
			"consumer.py": "from maths import twice as calculate\nassert calculate(21) == 42\n",
			"other.py": "def twice(value: str) -> str:\n    return value\n",
		});
		const runtime = createManagedLabRuntime(lab);
		try {
			// Wait for the configured project to finish indexing, without opening its consumer.
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const references = await runtime.router.findReferences(
					{ type: "position", path: "maths.py", position: { line: 0, character: 5 } },
					{ mode: "semantic", definitionId: "managed-python", timeoutMs: 10000 },
				);
				if (references.items.some((item) => item.location.path === "consumer.py")) break;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			await assertConsumerRename(
				runtime,
				lab.storeRoot,
				"maths.py",
				0,
				5,
				"managed-python",
				"twice",
				"double",
				"consumer.py",
				"other.py",
			);
			expect(lab.readText("consumer.py")).toContain("double as calculate");
			expect(lab.readText("other.py")).toContain("def twice");
			const execute = () =>
				execFileSync(process.env.MYHARNESS_PYTHON_TEST_EXECUTABLE ?? "python.exe", ["-B", lab.abs("consumer.py")], {
					cwd: lab.root,
					env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
					stdio: "pipe",
					windowsHide: true,
				});
			expect(
				runRestoredConsumerFault(
					lab,
					"consumer.py",
					(text) => text.replace("calculate(21)", 'calculate("invalid")'),
					execute,
				),
			).toEqual([true, false, true]);
			const original = lab.readText("consumer.py");
			lab.write("consumer.py", original.replace("calculate(21)", 'calculate("invalid")'));
			const routing = { mode: "semantic" as const, definitionId: "managed-python", timeoutMs: 30000 };
			expect(
				(await runtime.router.getDiagnostics("consumer.py", routing)).items.some(
					(item) => item.severity === "error",
				),
			).toBe(true);
			lab.write("consumer.py", original);
			const restored = await runtime.router.getDiagnostics("consumer.py", routing);
			expect(
				restored.items.some((item) => item.severity === "error"),
				JSON.stringify(restored),
			).toBe(false);
		} finally {
			await runtime.dispose();
		}
	}, 120000);
});
