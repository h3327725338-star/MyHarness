import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** @deprecated Use the OpenAI or Anthropic API directly. */
export const commandCodeApi = (): ProviderStreams => lazyApi(() => import("./command-code.ts"));
