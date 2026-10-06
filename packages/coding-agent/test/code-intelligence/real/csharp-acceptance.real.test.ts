import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeStore } from "../../../src/changes/change-store.ts";
import { ChangeControl, documentVersionLookup } from "../../../src/changes/service.ts";
import { CodeIntelligenceInstallationManager } from "../../../src/symbols/runtime/installation.ts";
import { CodeIntelligenceRuntime } from "../../../src/symbols/runtime/runtime.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "../../changes/helpers.ts";

const installs = new CodeIntelligenceInstallationManager({});
const csServer = installs
	.createInstalledLanguageServerRegistry()
	?.getAll()
	.find((server) => server.id === "managed-csharp");
afterEach(disposeTestWorkspaces);
describe.skipIf(!csServer)("real C# project acceptance", () => {
	it("builds net10 offline, renames unopened caller and detects introduced compiler errors", async () => {
		const project = createTestWorkspace({
			"Acceptance.csproj":
				'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><Nullable>enable</Nullable></PropertyGroup></Project>',
			"NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>",
			"Maths.cs":
				"namespace Acceptance;\npublic static class Maths { public static int Twice(int value) => value * 2; }\n",
			"Program.cs":
				"namespace Acceptance;\npublic class Program { public static void Main() { System.Console.WriteLine(Maths.Twice(21)); } }\n",
			"Other.cs":
				"namespace Acceptance;\npublic class Other { public static string Twice(string value) => value; }\n",
		});
		const sdkRoot = csServer?.env?.MYHARNESS_CODE_INTELLIGENCE_SHARED_ROOTS?.split(";").find((path) =>
			path.includes("dotnet-sdk-10"),
		);
		if (!sdkRoot) throw new Error("Private .NET SDK component missing");
		const sdk = join(sdkRoot, "servers/dotnet-10-sdk");
		const environment = {
			...process.env,
			DOTNET_ROOT: sdk,
			DOTNET_ROOT_X64: sdk,
			DOTNET_MULTILEVEL_LOOKUP: "0",
			DOTNET_CLI_HOME: project.abs(".dotnet"),
			NUGET_PACKAGES: project.abs(".nuget"),
			DOTNET_CLI_TELEMETRY_OPTOUT: "1",
			DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
			PATH: `${sdk};${process.env.PATH ?? ""}`,
		};
		const dotnet = (args: string[]) =>
			execFileSync(join(sdk, "dotnet.exe"), args, {
				cwd: project.root,
				env: environment,
				encoding: "utf8",
				stdio: "pipe",
				windowsHide: true,
				timeout: 60000,
			});
		dotnet(["restore", "Acceptance.csproj", "--configfile", "NuGet.Config"]);
		const build = () => dotnet(["build", "Acceptance.csproj", "--no-restore", "--nologo"]);
		expect(build).not.toThrow();
		const servers = installs.createInstalledLanguageServerRegistry({}, project.abs(".server-data"));
		const intelligence = new CodeIntelligenceRuntime({
			workspaceRoot: project.root,
			registry: servers,
			installationManager: installs,
			agentDir: project.storeRoot,
		});
		try {
			const object = { type: "position" as const, path: "Maths.cs", position: { line: 1, character: 47 } };
			const semantic = { mode: "semantic" as const, definitionId: "managed-csharp", timeoutMs: 60000 };
			const refs = await intelligence.router.findReferences(object, semantic);
			expect(refs.items.some((ref) => ref.location.path === "Program.cs")).toBe(true);
			expect(refs.items.some((ref) => ref.location.path === "Other.cs")).toBe(false);
			const requested = (await intelligence.router.rename(object, "Double", semantic)).items[0];
			if (!requested) throw new Error("C# server returned no rename");
			const changes = new ChangeControl({ workspaceRoot: project.root, store: new ChangeStore(project.storeRoot) });
			const proposed = await changes.previewWorkspaceEdit(requested.edit, {
				description: "Rename C# method",
				source: "rename",
				knownVersion: documentVersionLookup(requested.documentVersions, project.root),
				rename: { oldName: "Twice", newName: "Double" },
			});
			expect(proposed.changeset.files.map((file) => file.path)).toEqual(["Maths.cs", "Program.cs"]);
			await changes.apply(proposed.changeset.id, { origin: { kind: "refactor" } });
			expect(project.readText("Program.cs")).toContain("Maths.Double(21)");
			expect(project.readText("Other.cs")).toContain("Twice(string");
			expect(build).not.toThrow();
			const caller = project.readText("Program.cs");
			project.write("Program.cs", caller.replace("Double(21)", 'Double("invalid")'));
			expect(build).toThrow();
			project.write("Program.cs", caller);
			expect(build).not.toThrow();
		} finally {
			await intelligence.dispose();
		}
	}, 180000);
});
