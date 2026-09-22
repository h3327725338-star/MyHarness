import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const commandCodeApi = (): ProviderStreams => lazyApi(() => import("./command-code.ts"));
