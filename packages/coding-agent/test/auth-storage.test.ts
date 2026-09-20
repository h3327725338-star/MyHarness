import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Provider } from "@myharness/ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, readStoredCredential } from "../src/providers/credentials/auth-storage.ts";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>): void {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	test("reads and resolves stored API-key credentials", async () => {
		const original = process.env.TEST_AUTH_STORAGE_KEY;
		process.env.TEST_AUTH_STORAGE_KEY = "environment-key";
		try {
			writeAuthJson({ anthropic: { type: "api_key", key: "$TEST_AUTH_STORAGE_KEY" } });
			const storage = AuthStorage.create(authJsonPath);
			expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "environment-key" });
		} finally {
			if (original === undefined) delete process.env.TEST_AUTH_STORAGE_KEY;
			else process.env.TEST_AUTH_STORAGE_KEY = original;
		}
	});

	test("resolves command-backed API-key credentials", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "!printf 'command-key'" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "command-key" });
	});

	test("returns OAuth credentials unchanged", async () => {
		const credential = {
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		const storage = AuthStorage.inMemory({ anthropic: credential });
		expect(await storage.read("anthropic")).toEqual(credential);
	});

	test("credential-scoped env takes precedence and remains inspectable", async () => {
		writeAuthJson({
			anthropic: {
				type: "api_key",
				key: "$SCOPED_KEY",
				env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
			},
		});
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toMatchObject({
			key: "scoped-value",
			env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
		});
	});

	test("modify persists a credential while preserving unrelated external edits", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "old" },
			openai: { type: "api_key", key: "external" },
		});

		await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toMatchObject({
			anthropic: { type: "api_key", key: "new" },
			openai: { type: "api_key", key: "external" },
		});
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "new" });
	});

	test("modify with undefined leaves the current credential unchanged", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.modify("anthropic", async () => undefined)).toEqual({ type: "api_key", key: "stored" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored" });
	});

	test("serializes concurrent modifications", async () => {
		writeAuthJson({});
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		await Promise.all([
			first.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-key" })),
			second.modify("openai", async () => ({ type: "api_key", key: "openai-key" })),
		]);
		const current = AuthStorage.create(authJsonPath);
		expect(await current.read("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
		expect(await current.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
	});

	test("delete removes one credential while preserving others", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
			google: { type: "api_key", key: "external-key" },
		});
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "google", type: "api_key" },
		]);
		expect(await storage.read("anthropic")).toBeUndefined();
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
		expect(await storage.read("google")).toEqual({ type: "api_key", key: "external-key" });
	});

	test("in-memory storage implements the same credential-store behavior", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "initial" } });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "initial" });
		await storage.modify("anthropic", async () => ({ type: "api_key", key: "updated" }));
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "updated" });
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([]);
	});

	test("does not write after lock acquisition failure and recovers on retry", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		const lockSpy = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(new Error("lock unavailable"));

		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
			"lock unavailable",
		);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});

		lockSpy.mockRestore();
		await storage.modify("openai", async () => ({ type: "api_key", key: "new" }));
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toMatchObject({
			anthropic: { type: "api_key", key: "stored" },
			openai: { type: "api_key", key: "new" },
		});
	});

	test("surfaces a compromised OAuth refresh lock and allows a later retry", async () => {
		const providerId = "oauth-provider";
		writeAuthJson({
			[providerId]: {
				type: "oauth",
				access: "expired-access",
				refresh: "refresh-token",
				expires: 0,
			},
		});
		const storage = AuthStorage.create(authJsonPath);
		const provider: Provider = {
			id: providerId,
			name: "OAuth Provider",
			auth: {
				oauth: {
					name: "OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refresh: async (credential) => ({
						...credential,
						access: "refreshed-access",
						expires: Date.now() + 60_000,
					}),
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		};
		const models = createModels({ credentials: storage });
		models.setProvider(provider);

		const realLock = lockfile.lock.bind(lockfile);
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementationOnce(async (file, options) => {
			options?.onCompromised?.(new Error("lock compromised"));
			return realLock(file, options);
		});
		await expect(models.getAuth(providerId)).rejects.toMatchObject({ code: "auth" });

		lockSpy.mockRestore();
		await expect(models.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "refreshed-access" } });
	});

	test("does not overwrite malformed auth files", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		writeFileSync(authJsonPath, "{invalid-json", "utf8");
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow();
		expect(readFileSync(authJsonPath, "utf8")).toBe("{invalid-json");
	});

	test("treats a legacy single key as the active default key without rewriting the file", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "legacy-secret" } });
		const before = readFileSync(authJsonPath, "utf8");
		const storage = AuthStorage.create(authJsonPath);

		const overview = await storage.getProviderCredentialOverview("anthropic");
		expect(overview).toMatchObject({
			active: { type: "api_key" },
			hasOAuth: false,
			apiKeys: [{ label: "默认密钥", suffix: "cret", active: true }],
		});
		expect(readFileSync(authJsonPath, "utf8")).toBe(before);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "legacy-secret" });
	});

	test("adds multiple keys but changes the active key only when explicitly requested", async () => {
		const storage = AuthStorage.inMemory();
		const first = await storage.addApiKey("anthropic", "工作账号", {
			type: "api_key",
			key: "first-secret",
		});
		const second = await storage.addApiKey("anthropic", "备用账号", {
			type: "api_key",
			key: "second-secret",
		});

		expect(first.active).toBe(true);
		expect(second.active).toBe(false);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "first-secret" });

		await storage.activateApiKey("anthropic", second.id);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "second-secret" });
		expect(await storage.getProviderCredentialOverview("anthropic")).toMatchObject({
			active: { type: "api_key", keyId: second.id },
			apiKeys: [
				{ id: first.id, label: "工作账号", active: false },
				{ id: second.id, label: "备用账号", active: true },
			],
		});
	});

	test("updates and renames an inactive key without switching to it", async () => {
		const storage = AuthStorage.inMemory();
		const first = await storage.addApiKey("anthropic", "当前", { type: "api_key", key: "active-key" });
		const second = await storage.addApiKey("anthropic", "备用", { type: "api_key", key: "old-spare" });

		await storage.replaceApiKey("anthropic", second.id, { type: "api_key", key: "new-spare" });
		await storage.renameApiKey("anthropic", second.id, "第二账号");

		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "active-key" });
		expect(await storage.getProviderCredentialOverview("anthropic")).toMatchObject({
			active: { type: "api_key", keyId: first.id },
			apiKeys: [
				{ id: first.id, active: true },
				{ id: second.id, label: "第二账号", suffix: "pare", active: false },
			],
		});
	});

	test("rejects duplicate names and duplicate key values", async () => {
		const storage = AuthStorage.inMemory();
		await storage.addApiKey("anthropic", "工作账号", { type: "api_key", key: "same-secret" });

		await expect(
			storage.addApiKey("anthropic", "工作账号", { type: "api_key", key: "different-secret" }),
		).rejects.toThrow("已经存在");
		await expect(storage.addApiKey("anthropic", "其他账号", { type: "api_key", key: "same-secret" })).rejects.toThrow(
			"已经保存过",
		);
	});

	test("requires a manual replacement before deleting the active key", async () => {
		const storage = AuthStorage.inMemory();
		const first = await storage.addApiKey("anthropic", "当前", { type: "api_key", key: "first" });
		const second = await storage.addApiKey("anthropic", "替代", { type: "api_key", key: "second" });

		await expect(storage.deleteApiKey("anthropic", first.id)).rejects.toThrow("手动选择");
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "first" });

		await storage.deleteApiKey("anthropic", first.id, second.id);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "second" });
		expect((await storage.getProviderCredentialOverview("anthropic")).apiKeys).toHaveLength(1);
	});

	test("preserves OAuth while keys are added and manually switched", async () => {
		const oauth = {
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		const storage = AuthStorage.inMemory({ anthropic: oauth });
		const key = await storage.addApiKey("anthropic", "按量账号", {
			type: "api_key",
			key: "api-secret",
		});

		expect(key.active).toBe(false);
		expect(await storage.read("anthropic")).toEqual(oauth);
		expect(await storage.getProviderCredentialOverview("anthropic")).toMatchObject({
			active: { type: "oauth" },
			hasOAuth: true,
			apiKeys: [{ id: key.id, active: false }],
		});

		await storage.activateApiKey("anthropic", key.id);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "api-secret" });
		await storage.activateOAuth("anthropic");
		expect(await storage.read("anthropic")).toEqual(oauth);
	});

	test("deleting the last active key restores saved OAuth", async () => {
		const oauth = {
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		const storage = AuthStorage.inMemory({ anthropic: oauth });
		const key = await storage.addApiKey("anthropic", "按量账号", { type: "api_key", key: "api-secret" });
		await storage.activateApiKey("anthropic", key.id);
		await storage.deleteApiKey("anthropic", key.id);

		expect(await storage.read("anthropic")).toEqual(oauth);
		expect(await storage.getProviderCredentialOverview("anthropic")).toMatchObject({
			active: { type: "oauth" },
			apiKeys: [],
			hasOAuth: true,
		});
	});

	test("preserves inactive keys when the active OAuth credential is refreshed", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "old-access",
				refresh: "refresh-token",
				expires: 0,
			},
		});
		const key = await storage.addApiKey("anthropic", "按量账号", {
			type: "api_key",
			key: "api-secret",
		});

		await storage.modify("anthropic", async (current) =>
			current?.type === "oauth" ? { ...current, access: "new-access", expires: Date.now() + 60_000 } : current,
		);

		expect(await storage.read("anthropic")).toMatchObject({ type: "oauth", access: "new-access" });
		expect(await storage.getProviderCredentialOverview("anthropic")).toMatchObject({
			active: { type: "oauth" },
			apiKeys: [{ id: key.id, label: "按量账号", active: false }],
			hasOAuth: true,
		});
	});

	test("keeps metadata private when reading a stored credential", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "first" } });
		const storage = AuthStorage.create(authJsonPath);
		await storage.addApiKey("anthropic", "备用", { type: "api_key", key: "second" });

		expect(readStoredCredential("anthropic", authJsonPath)).toEqual({ type: "api_key", key: "first" });
		expect(Object.keys(readStoredCredential("anthropic", authJsonPath) ?? {})).not.toContain("__piApiKeys");
	});

	test("serializes concurrent additions to the same provider", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "first" } });
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		await Promise.all([
			first.addApiKey("anthropic", "第二个", { type: "api_key", key: "second" }),
			second.addApiKey("anthropic", "第三个", { type: "api_key", key: "third" }),
		]);

		const current = AuthStorage.create(authJsonPath);
		const overview = await current.getProviderCredentialOverview("anthropic");
		expect(overview.apiKeys.map((key) => key.label).sort()).toEqual(["第三个", "第二个", "默认密钥"].sort());
		expect(await current.read("anthropic")).toEqual({ type: "api_key", key: "first" });
	});
});
