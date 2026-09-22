import { COMMAND_CODE_PROVIDER_ID, createCommandCodeProvider } from "../command-code/index.ts";
import type { ModelRuntime } from "./provider-runtime.ts";

/**
 * Register the Command Code provider at product entrypoints.
 *
 * The provider reads Command Code's own login state, so it needs no `agentDir`
 * and no interactive setup step. Registration is idempotent.
 */
export async function registerBuiltInCommandCodeProvider(modelRuntime: ModelRuntime): Promise<boolean> {
	if (modelRuntime.getProviderCatalogProvider(COMMAND_CODE_PROVIDER_ID)) return false;
	modelRuntime.registerNativeProvider(createCommandCodeProvider());
	await modelRuntime.refresh({ allowNetwork: false });
	return true;
}
