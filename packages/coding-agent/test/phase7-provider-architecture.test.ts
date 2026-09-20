import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { ProviderCredentialManager } from "../src/providers/credentials/manager.ts";
import { ModelRegistry } from "../src/providers/models/registry.ts";
import { ProviderRecoveryCoordinator } from "../src/providers/recovery/coordinator.ts";
import { ProviderRuntime } from "../src/providers/runtime/provider-runtime.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativePath: string): string {
	return readFileSync(join(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

describe("Phase 7 provider boundaries", () => {
	it("keeps the formal Provider Runtime, credential, registry, and recovery entry points available", () => {
		expect(ProviderRuntime).toBeDefined();
		expect(AuthStorage).toBeDefined();
		expect(ModelRegistry).toBeDefined();
		expect(ProviderRecoveryCoordinator).toBeDefined();
		expect(ProviderCredentialManager).toBeDefined();
	});

	it("keeps Provider Runtime above focused credential, model, and recovery modules", () => {
		const runtime = readSource("packages/coding-agent/src/providers/runtime/provider-runtime.ts");
		const credentials = readSource("packages/coding-agent/src/providers/credentials/manager.ts");
		const models = readSource("packages/coding-agent/src/providers/models/index.ts");
		const recovery = readSource("packages/coding-agent/src/providers/recovery/index.ts");

		expect(runtime).toContain("../credentials/manager.ts");
		expect(runtime).toContain("../models/composer.ts");
		expect(runtime).not.toMatch(/from ["'][^"']*(?:frontend|modes\/interactive|myharness-tui)[^"']*["']/);
		expect(runtime).not.toContain("proper-lockfile");
		expect(credentials).toContain("migrateLegacyVisionCredentials");
		expect(credentials).toContain("ProviderCredentialManager");
		expect(models).toContain("custom-provider-manager.ts");
		expect(models).toContain("store.ts");
		expect(models).toContain("disabled.ts");
		expect(recovery).toContain("coordinator.ts");
	});

	it("keeps credential security and storage mechanics in the credential boundary", () => {
		const authStorage = readSource("packages/coding-agent/src/providers/credentials/auth-storage.ts");
		const modelStore = readSource("packages/coding-agent/src/providers/models/store.ts");

		expect(authStorage).toContain("proper-lockfile");
		expect(authStorage).toContain("onCompromised");
		expect(authStorage).toContain("writeAuthFileAtomically");
		expect(authStorage).toContain("chmodSync");
		expect(modelStore).toContain("FileModelsStore");
		expect(modelStore).toContain("FileAuthStorageBackend");
	});

	it("keeps the product-layer dependency direction independent of the frontend", () => {
		const files = [
			"packages/coding-agent/src/providers/runtime/provider-runtime.ts",
			"packages/coding-agent/src/providers/credentials/index.ts",
			"packages/coding-agent/src/providers/models/index.ts",
			"packages/coding-agent/src/providers/recovery/index.ts",
		];
		for (const file of files) {
			expect(readSource(file), `${file} must not depend on frontend implementations`).not.toMatch(
				/(?:frontend|modes\/interactive|myharness-tui)/,
			);
		}
	});
});
