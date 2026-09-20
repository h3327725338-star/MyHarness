import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, ImagesApi, ImagesModel, Model } from "../types.ts";

/**
 * MyHarness does not ship upstream Provider implementations or model catalogs.
 * Providers are configured in models.json or registered by an extension.
 */
export type BuiltinProvider = string;

/**
 * Legacy model-shaped descriptor for callers that still import `getModel()`.
 * This does not read a catalog, register a Provider, or provide credentials;
 * applications must still configure the real Provider in models.json or code.
 */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends string>(
	provider: TProvider,
	modelId: TModelId,
): Model<Api> {
	const api: Api = provider === "anthropic" ? "anthropic-messages" : "openai-completions";
	return {
		id: modelId,
		name: modelId,
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return [];
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(_provider: TProvider): Model<Api>[] {
	return [];
}

/** No upstream Provider factories are bundled. */
export function builtinProviders(): Provider[] {
	return [];
}

/** A Models collection with no preconfigured Providers. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	return createModels(options);
}

/** No upstream image Provider factories are bundled. */
export function builtinImagesProviders(): ImagesProvider[] {
	return [];
}

/** An ImagesModels collection with no preconfigured Providers. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return createImagesModels(options);
}

export type { Api, ImagesApi, ImagesModel };
