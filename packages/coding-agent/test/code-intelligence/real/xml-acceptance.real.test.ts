import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";
import { createManagedLabRuntime, runRestoredConsumerFault } from "./real-runtime.ts";

const installed = new CodeIntelligenceInstallationManager({}).createInstalledLanguageServerRegistry();
afterEach(disposeTestWorkspaces);
it.skipIf(process.platform !== "win32" || !installed?.getAll().some((entry) => entry.id === "managed-xml"))(
	"XML detects mismatched tags and independent System.Xml parsing fails then recovers",
	async () => {
		const lab = createTestWorkspace({ "sample.xml": "<sample><answer>42</answer></sample>\n" });
		const runtime = createManagedLabRuntime(lab);
		try {
			const execute = () =>
				execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'$ErrorActionPreference="Stop"; $settings=New-Object System.Xml.XmlReaderSettings; $settings.DtdProcessing=[System.Xml.DtdProcessing]::Prohibit; $reader=[System.Xml.XmlReader]::Create($env:MYHARNESS_XML_LAB,$settings); try { while($reader.Read()) {} } finally { $reader.Dispose() }',
					],
					{
						cwd: lab.root,
						env: { ...process.env, MYHARNESS_XML_LAB: lab.abs("sample.xml") },
						encoding: "utf8",
						stdio: "pipe",
						windowsHide: true,
					},
				);
			expect(
				runRestoredConsumerFault(lab, "sample.xml", (source) => source.replace("</answer>", "</wrong>"), execute),
			).toEqual([true, false, true]);
			for (const broken of [false, true, false]) {
				lab.write(
					"sample.xml",
					broken ? "<sample><answer>42</wrong></sample>\n" : "<sample><answer>42</answer></sample>\n",
				);
				const routing = { mode: "semantic" as const, definitionId: "managed-xml", timeoutMs: 30000 };
				let diagnostics = await runtime.router.getDiagnostics("sample.xml", routing);
				const deadline = Date.now() + 10000;
				while (
					diagnostics.items.some((item) => item.message.includes("matching end-tag")) !== broken &&
					Date.now() < deadline
				) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					diagnostics = await runtime.router.getDiagnostics("sample.xml", routing);
				}
				expect(
					diagnostics.items.some((item) => item.message.includes("matching end-tag")),
					JSON.stringify(diagnostics),
				).toBe(broken);
				expect(diagnostics.meta.completeness).toBe("partial");
			}
		} finally {
			await runtime.dispose();
		}
	},
	120000,
);
