import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";

import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { assertConsumerRename, createManagedLabRuntime, runRestoredConsumerFault } from "./real-runtime.ts";

const installation = new CodeIntelligenceInstallationManager({});
const registry = installation.createInstalledLanguageServerRegistry();
const server = registry?.getAll().find((item) => item.id === "managed-go");
afterEach(disposeTestWorkspaces);
describe.skipIf(!server)("real Go project acceptance", () => {
	it("renames unopened consumers and validates behavior and injected compiler failure with private Go", async () => {
		const lab = createTestWorkspace({
			"go.mod": "module acceptance\n\ngo 1.22\n",
			"maths.go": "package acceptance\nfunc Twice(value int) int { return value * 2 }\n",
			"consumer.go": "package acceptance\nfunc Answer() int { return Twice(21) }\n",
			"maths_test.go":
				'package acceptance\nimport "testing"\nfunc TestAnswer(t *testing.T) { if Answer() != 42 { t.Fatal("wrong answer") } }\n',
			"other/other.go": "package other\nfunc Twice(value string) string { return value }\n",
		});
		const runtime = createManagedLabRuntime(lab);
		try {
			const preview = await assertConsumerRename(
				runtime,
				lab.storeRoot,
				"maths.go",
				1,
				6,
				"managed-go",
				"Twice",
				"Double",
				"consumer.go",
				"other/other.go",
			);
			expect(preview.changeset.files.map((file) => file.path)).toEqual(["consumer.go", "maths.go"]);
			expect(lab.readText("consumer.go")).toContain("Double(21)");
			expect(lab.readText("other/other.go")).toContain("func Twice");
			const shared = server?.env?.MYHARNESS_CODE_INTELLIGENCE_SHARED_ROOTS?.split(";").find((path) =>
				path.includes("go-runtime"),
			);
			if (!shared) throw new Error("Managed Go runtime missing");
			const goroot = join(shared, "servers/go-1.27.1");
			const compile = () =>
				execFileSync(join(goroot, "bin/go.exe"), ["test", "./..."], {
					cwd: lab.root,
					env: {
						...process.env,
						GOROOT: goroot,
						GOTOOLCHAIN: "local",
						GOPROXY: "off",
						GOSUMDB: "off",
						GOPATH: join(lab.root, ".gopath"),
						GOCACHE: join(lab.root, ".gocache"),
					},
					stdio: "pipe",
					windowsHide: true,
				});
			expect(
				runRestoredConsumerFault(
					lab,
					"consumer.go",
					(text) => text.replace("Double(21)", 'Double("invalid")'),
					compile,
				),
			).toEqual([true, false, true]);
		} finally {
			await runtime.dispose();
		}
	}, 180000);
});
