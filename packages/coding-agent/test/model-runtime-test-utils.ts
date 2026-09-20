import type { Api, CredentialStore, Model } from "@myharness/ai";
import { ModelRegistry } from "../src/providers/models/registry.ts";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath, allowModelNetwork: false }));
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false }));
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}

/** Register the explicit manual model fixture used by tests that exercise AgentSession behavior. */
export function registerManualTestProvider(runtime: ModelRuntime, model: Model<Api>): void {
	runtime.registerProvider(model.provider, {
		name: model.provider,
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "test-key",
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				headers: model.headers,
				compat: model.compat,
			},
		],
	});
}
