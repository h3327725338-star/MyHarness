import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { applyRealRename, createManagedLabRuntime } from "./real-runtime.ts";

const registry = new CodeIntelligenceInstallationManager({}).createInstalledLanguageServerRegistry();
afterEach(disposeTestWorkspaces);
const samples = [
	{
		language: "json",
		definitionId: "managed-json",
		path: "sample.json",
		valid: '{"answer":42}',
		invalid: '{"answer":}',
		parse: JSON.parse,
	},
	{
		language: "yaml",
		definitionId: "managed-yaml",
		path: "sample.yaml",
		valid: "source: &answer 42\nvalue: *answer\n",
		invalid: "source: [42\n",
		parse: (text: string) => parseYaml(text),
	},
];
describe("real data-language diagnostics", () => {
	for (const sample of samples) {
		it.skipIf(!registry?.getAll().some((server) => server.id === sample.definitionId))(
			`${sample.language} independently parses valid data and rejects injected syntax errors`,
			async () => {
				const lab = createTestWorkspace({ [sample.path]: sample.valid });
				const runtime = createManagedLabRuntime(lab);
				try {
					const routing = { mode: "semantic" as const, definitionId: sample.definitionId, timeoutMs: 30000 };
					if (sample.language === "yaml") {
						const target = { type: "position" as const, path: sample.path, position: { line: 1, character: 9 } };
						const preview = await applyRealRename(runtime, lab.storeRoot, target, routing, "answer", "result");
						expect(preview.changeset.files.map((file) => file.path)).toEqual([sample.path]);
						const renamed = lab.readText(sample.path);
						expect(renamed).toContain("&result");
						expect(renamed).toContain("*result");
						expect(renamed).not.toContain("answer");
						expect(parseYaml(renamed)).toEqual({ source: 42, value: 42 });
						await expect(runtime.router.findReferences(target, routing)).rejects.toMatchObject({
							code: "unsupported_capability",
						});
					}
					for (const broken of [false, true, false]) {
						const text = broken ? sample.invalid : sample.valid;
						lab.write(sample.path, text);
						if (broken) expect(() => sample.parse(text)).toThrow();
						else expect(() => sample.parse(text)).not.toThrow();
						let diagnostics = await runtime.router.getDiagnostics(sample.path, routing);
						const deadline = Date.now() + 10000;
						while (
							diagnostics.items.some((item) => item.severity === "error") !== broken &&
							Date.now() < deadline
						) {
							await new Promise((resolve) => setTimeout(resolve, 100));
							diagnostics = await runtime.router.getDiagnostics(sample.path, routing);
						}
						expect(
							diagnostics.items.some((item) => item.severity === "error"),
							JSON.stringify(diagnostics),
						).toBe(broken);
						// These installed servers publish without versions: detection is verified, freshness remains partial.
						expect(diagnostics.meta.completeness).toBe("partial");
						expect(diagnostics.meta.warnings).toContain("diagnostics did not include a document version");
					}
				} finally {
					await runtime.dispose();
				}
			},
			90000,
		);
	}
});
