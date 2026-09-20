import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	CodeIntelligenceInstallationError,
	CodeIntelligenceInstallationManager,
	type CodeIntelligenceManifest,
} from "../../src/symbols/runtime/installation.ts";

const roots = new Set<string>();

afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.clear();
});

function metadata(fileName: string, payload: Buffer, expectedPaths: readonly string[]) {
	return {
		fileName,
		url: `fixture://${fileName}`,
		sizeBytes: payload.byteLength,
		sha256: createHash("sha256").update(payload).digest("hex"),
		expectedPaths,
	};
}

function manifest(
	payload: Buffer,
	options: { readonly firstVersion?: string; readonly secondVersion?: string } = {},
): CodeIntelligenceManifest {
	const firstVersion = options.firstVersion ?? "1.0.0";
	const secondVersion = options.secondVersion ?? "1.0.0";
	return {
		schemaVersion: 1,
		product: "myharness",
		platform: "win32-x64",
		defaultMode: "lightweight",
		releaseVersion: "test",
		releaseTag: "test",
		published: true,
		modules: [
			{
				id: "java",
				label: "Java",
				languages: ["java"],
				serverKey: "jdtls",
				serverVersion: firstVersion,
				sharedComponents: ["jre"],
				artifact: metadata("java.zip", payload, ["servers"]),
			},
			{
				id: "kotlin",
				label: "Kotlin",
				languages: ["kotlin"],
				serverKey: "kotlin-language-server",
				serverVersion: secondVersion,
				sharedComponents: ["jre"],
				artifact: metadata("kotlin.zip", payload, ["servers"]),
			},
		],
		sharedComponents: [
			{
				id: "jre",
				label: "JRE",
				version: "21",
				artifact: metadata("jre.zip", payload, ["servers"]),
			},
		],
	};
}

async function createManager(payload: Buffer, customManifest = manifest(payload)) {
	const root = await mkdtemp(path.join(tmpdir(), "myharness-code-intelligence-"));
	roots.add(root);
	const storeDir = path.join(root, "agent", "code-intelligence");
	const extractor = async (archivePath: string, destination: string) => {
		await mkdir(path.join(destination, "servers"), { recursive: true });
		await writeFile(path.join(destination, "servers", path.basename(archivePath, ".download")), "fixture", "utf8");
	};
	return {
		root,
		manager: new CodeIntelligenceInstallationManager({
			storeDir,
			manifest: customManifest,
			platform: "win32",
			downloader: async (_url, destination) => writeFile(destination, payload),
			extractor,
			launcherPath: path.join(root, "lsp-launcher.mjs"),
		}),
	};
}

describe("CodeIntelligenceInstallationManager", () => {
	it("refuses an unverified release and persists a recoverable error", async () => {
		const payload = Buffer.from("verified archive");
		const original = manifest(payload);
		const broken: CodeIntelligenceManifest = {
			...original,
			modules: original.modules.map((entry, index) =>
				index === 0 ? { ...entry, artifact: { ...entry.artifact!, sha256: "0".repeat(64) } } : entry,
			),
		};
		const { manager } = await createManager(payload, broken);

		await expect(manager.install("java")).rejects.toBeInstanceOf(CodeIntelligenceInstallationError);
		expect(manager.getModuleStatus("java").status).toBe("error");
		expect(manager.getModuleStatus("java").message).toContain("SHA-256 mismatch");
		await manager.remove("java");
		expect(manager.getModuleStatus("java").status).toBe("not-installed");
	});

	it("refuses a release outside the MyHarness compatibility range", async () => {
		const payload = Buffer.from("verified archive");
		const incompatible = { ...manifest(payload), myharnessVersionRange: ">=2.0.0 <3.0.0" };
		const { manager } = await createManager(payload, incompatible);

		expect(manager.getModuleStatus("java").status).toBe("unavailable");
		await expect(manager.install("java")).rejects.toMatchObject({ code: "incompatible-version" });
	});

	it("installs, reloads, detects repair/update, and removes one language", async () => {
		const payload = Buffer.from("verified archive");
		const { manager, root } = await createManager(payload);
		await expect(manager.install("java")).resolves.toBeUndefined();
		expect(manager.getModuleStatus("java").status).toBe("installed");

		const reloaded = new CodeIntelligenceInstallationManager({
			storeDir: path.join(root, "agent", "code-intelligence"),
			manifest: manifest(payload),
			platform: "win32",
			launcherPath: path.join(root, "lsp-launcher.mjs"),
			downloader: async (_url, destination) => writeFile(destination, payload),
			extractor: async (_archivePath, destination) => {
				await mkdir(path.join(destination, "servers"), { recursive: true });
				await writeFile(path.join(destination, "servers", "reloaded"), "reloaded", "utf8");
			},
		});
		expect(reloaded.getModuleStatus("java").status).toBe("installed");

		const markerPath = path.join(
			root,
			"agent",
			"code-intelligence",
			"modules",
			"java",
			"1.0.0",
			".myharness-code-intelligence.json",
		);
		await rm(markerPath);
		expect(reloaded.getModuleStatus("java").status).toBe("repair-needed");
		await reloaded.repair("java");
		expect(reloaded.getModuleStatus("java").status).toBe("installed");

		const updatedManifest = manifest(payload, { firstVersion: "2.0.0" });
		const updated = new CodeIntelligenceInstallationManager({
			storeDir: path.join(root, "agent", "code-intelligence"),
			manifest: updatedManifest,
			platform: "win32",
			launcherPath: path.join(root, "lsp-launcher.mjs"),
			downloader: async (_url, destination) => writeFile(destination, payload),
			extractor: async (_archivePath, destination) => {
				await mkdir(path.join(destination, "servers"), { recursive: true });
				await writeFile(path.join(destination, "servers", "updated"), "updated", "utf8");
			},
		});
		expect(updated.getModuleStatus("java").status).toBe("update-available");
		await updated.install("java");
		expect(updated.getModuleStatus("java").installedVersion).toBe("2.0.0");
		await updated.remove("java");
		expect(updated.getModuleStatus("java").status).toBe("not-installed");
	});

	it("keeps a shared dependency until the last language using it is removed", async () => {
		const payload = Buffer.from("verified archive");
		const { manager, root } = await createManager(payload);
		await manager.install("java");
		await manager.install("kotlin");
		const componentPath = path.join(root, "agent", "code-intelligence", "components", "jre", "21");
		expect(manager.getModuleStatus("java").status).toBe("installed");
		expect(await readFile(path.join(componentPath, ".myharness-code-intelligence.json"), "utf8")).toContain(
			"component",
		);

		await manager.remove("java");
		expect(manager.getModuleStatus("kotlin").status).toBe("installed");
		expect(manager.getModuleStatus("kotlin").status).not.toBe("repair-needed");
		expect(await readFile(path.join(componentPath, ".myharness-code-intelligence.json"), "utf8")).toContain(
			"component",
		);
		await manager.remove("kotlin");
		await expect(readFile(path.join(componentPath, ".myharness-code-intelligence.json"), "utf8")).rejects.toThrow();
	});
});
