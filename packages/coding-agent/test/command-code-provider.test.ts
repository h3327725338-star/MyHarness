import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthContext, InMemoryCredentialStore } from "@myharness/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCommandCodeModels,
	COMMAND_CODE_CATALOG,
	COMMAND_CODE_PROVIDER_ID,
	createCommandCodeProvider,
	getCommandCodeAuthPath,
	readCommandCodeAuthFile,
	resolveCommandCodeCredential,
} from "../src/providers/command-code/index.ts";
import { ModelRuntime, registerBuiltInCommandCodeProvider } from "../src/providers/runtime/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** AuthContext stub: only `env` is consulted by the credential resolver. */
function authContext(env: Record<string, string> = {}): AuthContext {
	return {
		env: async (name: string) => env[name],
		fileExists: async () => false,
	};
}

describe("command-code credential discovery", () => {
	it("points at the auth file the Command Code client writes", () => {
		expect(getCommandCodeAuthPath("C:/Users/example")).toBe(join("C:/Users/example", ".commandcode", "auth.json"));
	});

	it("reads a well-formed auth file", async () => {
		const directory = temporaryDirectory("cc-auth-");
		const path = join(directory, "auth.json");
		writeFileSync(
			path,
			JSON.stringify({
				apiKey: "file-key",
				userId: "u1",
				userName: "HUSHUNBO",
				keyName: "desktop",
				authenticatedAt: "2026-09-07T08:16:00.000Z",
			}),
		);
		await expect(readCommandCodeAuthFile(path)).resolves.toMatchObject({
			apiKey: "file-key",
			userName: "HUSHUNBO",
		});
	});

	it("returns undefined for a missing or malformed file instead of throwing", async () => {
		const directory = temporaryDirectory("cc-auth-");
		await expect(readCommandCodeAuthFile(join(directory, "absent.json"))).resolves.toBeUndefined();

		const malformed = join(directory, "malformed.json");
		writeFileSync(malformed, "{not json");
		await expect(readCommandCodeAuthFile(malformed)).resolves.toBeUndefined();

		const arrayFile = join(directory, "array.json");
		writeFileSync(arrayFile, "[]");
		await expect(readCommandCodeAuthFile(arrayFile)).resolves.toBeUndefined();
	});

	it("prefers the environment override over the stored login", async () => {
		const credential = await resolveCommandCodeCredential(
			authContext({ COMMAND_CODE_API_KEY: "env-key" }),
			async () => ({ apiKey: "file-key" }),
		);
		expect(credential).toEqual({ value: "env-key", source: "COMMAND_CODE_API_KEY" });
	});

	it("falls back to the shared login state and labels it without the secret", async () => {
		const credential = await resolveCommandCodeCredential(authContext(), async () => ({
			apiKey: "file-key",
			userName: "HUSHUNBO",
		}));
		expect(credential).toEqual({
			value: "file-key",
			source: "~/.commandcode/auth.json",
			accountName: "HUSHUNBO",
		});
		// The source label must never carry the key itself.
		expect(credential?.source).not.toContain("file-key");
	});

	it("reports no credential when neither source is present", async () => {
		await expect(resolveCommandCodeCredential(authContext(), async () => undefined)).resolves.toBeUndefined();
		await expect(
			resolveCommandCodeCredential(authContext(), async () => ({ apiKey: "   " })),
		).resolves.toBeUndefined();
	});

	it("treats a blank environment value as absent", async () => {
		await expect(
			resolveCommandCodeCredential(authContext({ COMMAND_CODE_API_KEY: "  " }), async () => undefined),
		).resolves.toBeUndefined();
	});
});

describe("command-code model catalog", () => {
	it("builds every catalog entry as a command-code model", () => {
		const models = buildCommandCodeModels();
		expect(models.length).toBe(COMMAND_CODE_CATALOG.length);
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.api).toBe("command-code");
			expect(model.provider).toBe(COMMAND_CODE_PROVIDER_ID);
			expect(model.baseUrl).toBe("https://api.commandcode.ai");
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
			expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);
			expect(model.cost.cacheWrite).toBe(0);
		}
	});

	it("never claims image input for a text-only model", () => {
		for (const entry of COMMAND_CODE_CATALOG) {
			const model = buildCommandCodeModels().find((candidate) => candidate.id === entry.id)!;
			expect(model.input.includes("image")).toBe(entry.input.includes("image"));
		}
	});

	it("marks reasoning support from the declared effort list", () => {
		const flash = COMMAND_CODE_CATALOG.find((entry) => entry.id === "deepseek/deepseek-v4-flash")!;
		expect(flash.reasoning).toBe(true);
		// Declared efforts are identity-mapped; undeclared levels are explicitly null.
		expect(flash.thinkingLevelMap).toMatchObject({ high: "high", max: "max", low: null, minimal: null });

		const noEffort = COMMAND_CODE_CATALOG.find((entry) => entry.id === "moonshotai/Kimi-K2.7-Code")!;
		expect(noEffort.reasoning).toBe(false);
		expect(noEffort.thinkingLevelMap).toBeUndefined();
	});

	it("carries the verified platform pricing", () => {
		const pro = buildCommandCodeModels().find((model) => model.id === "deepseek/deepseek-v4-pro")!;
		expect(pro.cost).toEqual({ input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 });
	});
});

describe("command-code provider", () => {
	it("describes itself as an independent provider", () => {
		const provider = createCommandCodeProvider();
		expect(provider.id).toBe(COMMAND_CODE_PROVIDER_ID);
		expect(provider.name).toBe("Command Code");
		expect(provider.baseUrl).toBe("https://api.commandcode.ai");
		expect(provider.getModels().length).toBe(COMMAND_CODE_CATALOG.length);
		expect(provider.auth.apiKey).toBeDefined();
	});

	it("resolves auth from the environment override without a login flow", async () => {
		const provider = createCommandCodeProvider();
		const resolution = await provider.auth.apiKey!.resolve({
			ctx: authContext({ COMMAND_CODE_API_KEY: "env-key" }),
		});
		expect(resolution).toEqual({ auth: { apiKey: "env-key" }, source: "COMMAND_CODE_API_KEY" });
	});

	it("reports availability through check() for the same source", async () => {
		const provider = createCommandCodeProvider();
		const check = await provider.auth.apiKey!.check!({
			ctx: authContext({ COMMAND_CODE_API_KEY: "env-key" }),
		});
		expect(check).toEqual({ type: "api_key", source: "COMMAND_CODE_API_KEY" });
	});

	it("does not offer an interactive login, since it reuses Command Code's own", () => {
		expect(createCommandCodeProvider().auth.apiKey!.login).toBeUndefined();
	});
});

describe("command-code provider registration", () => {
	async function createRuntime(): Promise<ModelRuntime> {
		return ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
	}

	it("registers into the provider catalog", async () => {
		const runtime = await createRuntime();
		expect(runtime.getProviderCatalogProvider(COMMAND_CODE_PROVIDER_ID)).toBeUndefined();

		const registered = await registerBuiltInCommandCodeProvider(runtime);

		expect(registered).toBe(true);
		expect(runtime.getProviderCatalogProvider(COMMAND_CODE_PROVIDER_ID)).toBeDefined();
		expect(runtime.getProviderCatalogModels(COMMAND_CODE_PROVIDER_ID).length).toBe(COMMAND_CODE_CATALOG.length);
	});

	it("is idempotent", async () => {
		const runtime = await createRuntime();
		expect(await registerBuiltInCommandCodeProvider(runtime)).toBe(true);
		expect(await registerBuiltInCommandCodeProvider(runtime)).toBe(false);
	});

	it("keeps a registered provider selectable even without a MyHarness credential", async () => {
		const runtime = await createRuntime();
		await registerBuiltInCommandCodeProvider(runtime);
		// Registration marks the provider active; request auth is decided later by
		// the Command Code credential check, not by MyHarness's own credential store.
		expect(runtime.getConfiguredProviderIds()).toContain(COMMAND_CODE_PROVIDER_ID);
		expect(runtime.getProviderCatalogModel(COMMAND_CODE_PROVIDER_ID, "deepseek/deepseek-v4-pro")).toBeDefined();
	});
});
