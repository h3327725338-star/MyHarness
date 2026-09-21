import { createOpenAIChatGPTProvider, OPENAI_CHATGPT_PROVIDER_ID } from "../openai-chatgpt/index.ts";
import type { ModelRuntime } from "./provider-runtime.ts";

/** Register the managed ChatGPT provider at product entrypoints. */
export async function registerBuiltInOpenAIChatGPTProvider(
	modelRuntime: ModelRuntime,
	agentDir: string,
): Promise<boolean> {
	if (modelRuntime.getProviderCatalogProvider(OPENAI_CHATGPT_PROVIDER_ID)) return false;
	modelRuntime.registerNativeProvider(createOpenAIChatGPTProvider({ agentDir }));
	await modelRuntime.refresh({ allowNetwork: false });
	return true;
}
