import { InMemoryCredentialStore } from "@myharness/ai";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/providers/credentials/auth-storage.ts";
import { RuntimeCredentials } from "../src/providers/credentials/runtime.ts";

describe("RuntimeCredentials", () => {
	test("runtime overrides mask stored credentials without persisting", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);

		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });

		credentials.removeRuntimeApiKey("anthropic");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });
	});

	test("enumeration merges overrides without exposing keys", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
		});
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		credentials.setRuntimeApiKey("openai", "other-runtime-key");

		expect(await credentials.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
	});

	test("delete clears both the override and persisted credential", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await credentials.delete("anthropic");

		expect(await credentials.read("anthropic")).toBeUndefined();
		expect(await credentials.list()).toEqual([]);
	});

	test("delegates manual key management while a runtime override remains authoritative", async () => {
		const storage = AuthStorage.inMemory();
		const credentials = new RuntimeCredentials(storage);
		const first = await credentials.addApiKey("anthropic", "第一个", {
			type: "api_key",
			key: "stored-first",
		});
		const second = await credentials.addApiKey("anthropic", "第二个", {
			type: "api_key",
			key: "stored-second",
		});
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await credentials.activateApiKey("anthropic", second.id);
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
		expect(await credentials.getProviderCredentialOverview("anthropic")).toMatchObject({
			active: { type: "api_key", keyId: second.id },
			runtimeOverride: true,
			apiKeys: [
				{ id: first.id, active: false },
				{ id: second.id, active: true },
			],
		});

		credentials.removeRuntimeApiKey("anthropic");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "stored-second" });
	});

	test("deletes a legacy single-key credential through the management API", async () => {
		const storage = new InMemoryCredentialStore();
		await storage.modify("anthropic", async () => ({ type: "api_key", key: "legacy-key" }));
		const credentials = new RuntimeCredentials(storage);

		await credentials.deleteApiKey("anthropic", "legacy");

		expect(await storage.read("anthropic")).toBeUndefined();
	});
});
