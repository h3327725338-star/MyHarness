import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { createManagedLabRuntime, runRestoredConsumerFault } from "./real-runtime.ts";

const bash = "C:/Program Files/Git/bin/bash.exe";
const registry = new CodeIntelligenceInstallationManager({}).createInstalledLanguageServerRegistry();
afterEach(disposeTestWorkspaces);
it.skipIf(!existsSync(bash) || !registry?.getAll().some((server) => server.id === "managed-shell"))(
	"Shell reports unopened sourced-consumer coverage as partial, independently confirms omitted rename breaks behavior",
	async () => {
		const lab = createTestWorkspace({
			"maths.sh": 'twice() { echo "$(( $1 * 2 ))"; }\n',
			"consumer.sh": 'set -eu\nsource ./maths.sh\ntest "$(twice 21)" = 42\n',
		});
		const runtime = createManagedLabRuntime(lab);
		try {
			const target = { type: "position" as const, path: "maths.sh", position: { line: 0, character: 2 } };
			const routing = { mode: "semantic" as const, definitionId: "managed-shell", timeoutMs: 30000 };
			const refs = await runtime.router.findReferences(target, routing);
			expect(refs.meta.completeness).toBe("partial");
			expect(refs.meta.warnings?.join(" ")).toContain("unopened sourced consumers");
			const renamed = await runtime.router.rename(target, "double", routing);
			expect(renamed.meta.completeness).toBe("partial");
			// A protocol edit is not a project-safe rename: do not apply the incomplete proposal.
			expect(
				runRestoredConsumerFault(
					lab,
					"consumer.sh",
					(text) => text.replace("twice 21", "missing 21"),
					() =>
						execFileSync(bash, ["--noprofile", "--norc", "consumer.sh"], {
							cwd: lab.root,
							encoding: "utf8",
							stdio: "pipe",
							windowsHide: true,
						}),
				),
			).toEqual([true, false, true]);
		} finally {
			await runtime.dispose();
		}
	},
	90000,
);
