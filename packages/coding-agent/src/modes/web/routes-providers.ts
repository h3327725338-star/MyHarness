/**
 * Web API routes for Providers: enable/disable, stored API keys, OAuth login
 * and user-defined (models.json) providers. Credentials never leave the
 * server: the browser only receives labels and the last four characters.
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from "@myharness/ai";
import { ProviderSettingsUseCase } from "../../application/use-cases/provider-settings.ts";
import type { ModelsJsonProvider } from "../../providers/models/config.ts";
import {
	CUSTOM_PROVIDER_API_TYPES,
	type CustomProviderApiType,
	CustomProviderManager,
	discoverProviderModels,
	ProviderModelDiscoveryError,
} from "../../providers/models/custom-provider-manager.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

function asObject(body: unknown): Record<string, unknown> {
	if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	throw new HttpError(400, "Expected a JSON object body");
}

function str(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `"${name}" must be a non-empty string`);
	return value;
}

class LoginCancelled extends Error {}

const HIDDEN = "__hidden__";

/** models.json may hold literal keys / auth headers: the browser only sees a placeholder. */
function redactProvider(config: ModelsJsonProvider): ModelsJsonProvider {
	const copy = structuredClone(config);
	if (copy.apiKey) copy.apiKey = HIDDEN;
	if (copy.headers) for (const key of Object.keys(copy.headers)) copy.headers[key] = HIDDEN;
	for (const model of copy.models ?? [])
		if (model.headers) for (const key of Object.keys(model.headers)) model.headers[key] = HIDDEN;
	return copy;
}

/** Restore hidden placeholders from the stored provider so an edit that did not touch secrets keeps them. */
function restoreSecrets(incoming: ModelsJsonProvider, stored: ModelsJsonProvider | undefined): ModelsJsonProvider {
	const copy = structuredClone(incoming);
	if (copy.apiKey === HIDDEN) {
		if (stored?.apiKey) copy.apiKey = stored.apiKey;
		else delete copy.apiKey;
	}
	if (copy.headers) {
		for (const key of Object.keys(copy.headers)) {
			if (copy.headers[key] !== HIDDEN) continue;
			const previous = stored?.headers?.[key];
			if (previous !== undefined) copy.headers[key] = previous;
			else delete copy.headers[key];
		}
	}
	copy.models?.forEach((model, index) => {
		if (!model.headers) return;
		const previousModel = stored?.models?.find((candidate) => candidate.id === model.id) ?? stored?.models?.[index];
		for (const key of Object.keys(model.headers)) {
			if (model.headers[key] !== HIDDEN) continue;
			const previous = previousModel?.headers?.[key];
			if (previous !== undefined) model.headers[key] = previous;
			else delete model.headers[key];
		}
	});
	return copy;
}

export function registerProviderRoutes(server: WebHttpServer, host: WebHost): void {
	const runtime = () => host.session.modelRuntime;
	const providerSettings = new ProviderSettingsUseCase({
		getSession: () => host.session,
		getSettingsManager: () => host.session.settingsManager,
	});
	let activeLogin: AbortController | undefined;

	/** Login interaction backed by browser dialogs; secrets are typed into the browser only. */
	const createInteraction = (apiKeyValue?: string): AuthInteraction => {
		const controller = new AbortController();
		activeLogin = controller;
		return {
			signal: controller.signal,
			prompt: async (prompt: AuthPrompt) => {
				if (apiKeyValue !== undefined && (prompt.type === "secret" || prompt.type === "text")) return apiKeyValue;
				if (prompt.type === "select") {
					const labels = prompt.options.map((option) => option.label);
					const answer = await host.dialogs.ask(
						"select",
						{ title: prompt.message, options: labels },
						{ signal: prompt.signal ?? controller.signal },
					);
					const chosen = prompt.options.find((option) => option.label === answer);
					if (!chosen) throw new LoginCancelled("Login cancelled");
					return chosen.id;
				}
				const answer = await host.dialogs.ask(
					"input",
					{
						title: prompt.message,
						placeholder:
							prompt.type === "manual_code" ? "Paste the authorization code or URL" : prompt.placeholder,
					},
					{ signal: prompt.signal ?? controller.signal },
				);
				if (typeof answer !== "string" || !answer) throw new LoginCancelled("Login cancelled");
				return answer;
			},
			notify: (event: AuthEvent) => {
				if (event.type === "auth_url") {
					openBrowser(event.url);
					host.broadcast("login_event", {
						type: "auth_url",
						url: event.url,
						instructions: event.instructions ?? null,
					});
				} else if (event.type === "device_code") {
					openBrowser(event.verificationUri);
					host.broadcast("login_event", {
						type: "device_code",
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						expiresInSeconds: event.expiresInSeconds ?? null,
					});
				} else if (event.type === "info") {
					host.broadcast("login_event", { type: "info", message: event.message, links: event.links ?? [] });
				} else if (event.type === "progress") {
					host.broadcast("login_event", { type: "progress", message: event.message });
				}
			},
		};
	};

	const afterCredentialChange = async () => {
		await host.session.reconcileModelAfterConfigChange();
		host.broadcast("models_changed", {});
	};

	server.route("GET", "/api/providers", async () => {
		const rt = runtime();
		const disabled = new Set(host.session.settingsManager.getDisabledProviders());
		const providers = [];
		for (const provider of rt.getProviders()) {
			const overview = await rt.getProviderCredentialOverview(provider.id).catch(() => undefined);
			const status = rt.getProviderAuthStatus(provider.id);
			providers.push({
				id: provider.id,
				name: provider.name,
				baseUrl: provider.baseUrl ?? null,
				enabled: !disabled.has(provider.id),
				configured: status.configured,
				authSource: status.configured ? (status.source ?? null) : null,
				supportsApiKeyLogin: typeof provider.auth.apiKey?.login === "function",
				supportsOAuth: provider.auth.oauth !== undefined,
				modelCount: provider.getModels().length,
				credentials: overview
					? {
							active: overview.active ?? null,
							apiKeys: overview.apiKeys.map((key) => ({
								id: key.id,
								label: key.label,
								suffix: key.suffix ?? null,
								active: key.active,
							})),
							hasOAuth: overview.hasOAuth,
							runtimeOverride: overview.runtimeOverride === true,
						}
					: null,
			});
		}
		return { providers, modelsPath: rt.getModelsConfigPath() ?? null, error: rt.getError() ?? null };
	});

	server.route("POST", "/api/providers/enabled", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id");
		if (typeof payload.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
		try {
			await providerSettings.setProviderEnabled(id, payload.enabled);
		} catch (error) {
			throw new HttpError(409, error instanceof Error ? error.message : String(error));
		}
		await host.session.settingsManager.flush();
		host.broadcast("models_changed", {});
		return { ok: true };
	});

	server.route("POST", "/api/providers/api-key/add", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id");
		const key = str(payload.key, "key").trim();
		const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim() : "Default key";
		try {
			const saved = await runtime().addProviderApiKey(id, label, createInteraction(key));
			await afterCredentialChange();
			return { ok: true, active: saved.active };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/providers/api-key/replace", async ({ body }) => {
		const payload = asObject(body);
		try {
			await runtime().replaceProviderApiKey(
				str(payload.id, "id"),
				str(payload.keyId, "keyId"),
				createInteraction(str(payload.key, "key").trim()),
			);
			await afterCredentialChange();
			return { ok: true };
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	});

	server.route("POST", "/api/providers/api-key/rename", async ({ body }) => {
		const payload = asObject(body);
		await runtime().renameProviderApiKey(
			str(payload.id, "id"),
			str(payload.keyId, "keyId"),
			str(payload.label, "label").trim(),
		);
		return { ok: true };
	});

	server.route("POST", "/api/providers/api-key/activate", async ({ body }) => {
		const payload = asObject(body);
		await runtime().activateProviderApiKey(str(payload.id, "id"), str(payload.keyId, "keyId"));
		await afterCredentialChange();
		return { ok: true };
	});

	server.route("POST", "/api/providers/api-key/delete", async ({ body }) => {
		const payload = asObject(body);
		const replacement = typeof payload.replacementKeyId === "string" ? payload.replacementKeyId : undefined;
		await runtime().deleteProviderApiKey(str(payload.id, "id"), str(payload.keyId, "keyId"), replacement);
		await afterCredentialChange();
		return { ok: true };
	});

	server.route("POST", "/api/providers/oauth/activate", async ({ body }) => {
		await runtime().activateProviderOAuth(str(asObject(body).id, "id"));
		await afterCredentialChange();
		return { ok: true };
	});

	server.route("POST", "/api/providers/oauth/login", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		try {
			await runtime().login(id, "oauth", createInteraction());
			await afterCredentialChange();
			return { ok: true };
		} catch (error) {
			if (error instanceof LoginCancelled) return { ok: false, cancelled: true };
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		} finally {
			activeLogin = undefined;
			host.broadcast("login_event", { type: "done" });
		}
	});

	server.route("POST", "/api/providers/login/abort", () => {
		activeLogin?.abort();
		host.dialogs.dismissAll();
		return { ok: true };
	});

	server.route("POST", "/api/providers/logout", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		await runtime().deleteProviderCredentials(id);
		await afterCredentialChange();
		return { ok: true };
	});

	// ---- User-defined providers (models.json) --------------------------------------------
	const manager = () => new CustomProviderManager(runtime().getModelsConfigPath());

	server.route("GET", "/api/providers/custom", async () => {
		const entries = await manager().list();
		return {
			path: runtime().getModelsConfigPath() ?? null,
			apiTypes: [...CUSTOM_PROVIDER_API_TYPES],
			providers: entries.map((entry) => ({ id: entry.id, config: redactProvider(entry.config) })),
			hiddenPlaceholder: HIDDEN,
		};
	});

	/**
	 * Reads the model catalog of an endpoint so the form can offer its models and the capabilities the catalog states.
	 * A failed lookup is an answer, not an error: the form keeps working with manually entered models.
	 */
	server.route("POST", "/api/providers/custom/detect", async ({ body }) => {
		const payload = asObject(body);
		const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
		const api = typeof payload.api === "string" ? payload.api : "";
		const existingId = typeof payload.id === "string" && payload.id ? payload.id : undefined;
		if (!baseUrl) throw new HttpError(400, "Enter the Base URL first.");
		if (!(CUSTOM_PROVIDER_API_TYPES as readonly string[]).includes(api))
			throw new HttpError(400, "Choose an API type first.");
		let apiKey = typeof payload.apiKey === "string" && payload.apiKey.trim() ? payload.apiKey.trim() : undefined;
		let authType: "api_key" | "oauth" = "api_key";
		let headers: Record<string, string> | undefined;
		if (existingId) {
			const stored = await manager()
				.get(existingId)
				.catch(() => undefined);
			headers = stored?.headers;
			if (!apiKey) {
				const auth = await runtime()
					.getAuth(existingId)
					.catch(() => undefined);
				apiKey = auth?.auth.apiKey;
				if (auth?.source === "OAuth") authType = "oauth";
			}
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			const models = await discoverProviderModels({
				baseUrl,
				api: api as CustomProviderApiType,
				apiKey,
				authType,
				headers,
				signal: controller.signal,
			});
			return { ok: true, models };
		} catch (error) {
			if (error instanceof ProviderModelDiscoveryError)
				return { ok: false, code: error.code, message: error.message };
			return { ok: false, code: "connection", message: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	});

	server.route("POST", "/api/providers/custom/save", async ({ body }) => {
		const payload = asObject(body);
		const id = str(payload.id, "id").trim();
		const previousId = typeof payload.previousId === "string" && payload.previousId ? payload.previousId : undefined;
		const config = payload.config;
		if (!config || typeof config !== "object" || Array.isArray(config))
			throw new HttpError(400, "config must be an object");
		// An API key typed in the form goes to the credential store (like the TUI does), not into models.json.
		const newKey = typeof payload.apiKey === "string" && payload.apiKey.trim() ? payload.apiKey.trim() : undefined;
		const keyLabel =
			typeof payload.keyLabel === "string" && payload.keyLabel.trim() ? payload.keyLabel.trim() : "Default key";
		const custom = manager();
		const snapshot = await custom.snapshot().catch(() => undefined);
		let savedKeyId: string | undefined;
		try {
			const stored = await custom.get(previousId ?? id).catch(() => undefined);
			await custom.upsert(id, restoreSecrets(config as ModelsJsonProvider, stored), previousId);
			await runtime().reloadConfig();
			const configError = runtime().getError();
			if (configError) throw new Error(configError);
			if (newKey) savedKeyId = (await runtime().addProviderApiKey(id, keyLabel, createInteraction(newKey))).id;
			await host.session.reconcileModelAfterConfigChange();
		} catch (error) {
			if (savedKeyId) {
				await runtime()
					.deleteProviderApiKey(id, savedKeyId)
					.catch(() => {});
			}
			if (snapshot) await custom.restore(snapshot).catch(() => {});
			await runtime()
				.reloadConfig()
				.catch(() => {});
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		host.broadcast("models_changed", {});
		return { ok: true };
	});

	/**
	 * Removes the provider for good: its models.json entry, every stored API key / login, and the settings that point at
	 * it. If a step fails the models.json change is rolled back, so the provider is not left half deleted.
	 */
	server.route("POST", "/api/providers/custom/delete", async ({ body }) => {
		const id = str(asObject(body).id, "id");
		const custom = manager();
		const snapshot = await custom.snapshot();
		try {
			if (!(await custom.delete(id))) throw new HttpError(404, "No such provider in models.json");
			await runtime().deleteProviderCredentials(id);
			host.session.settingsManager.clearModelReferences(id, undefined, true);
			await host.session.settingsManager.flush();
			await runtime().reloadConfig();
			await host.session.reconcileModelAfterConfigChange();
			await host.session.settingsManager.flush();
		} catch (error) {
			await custom.restore(snapshot).catch(() => {});
			await runtime()
				.reloadConfig()
				.catch(() => {});
			if (error instanceof HttpError) throw error;
			throw new HttpError(
				500,
				`Could not delete the provider: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		host.broadcast("models_changed", {});
		return { ok: true };
	});
}
