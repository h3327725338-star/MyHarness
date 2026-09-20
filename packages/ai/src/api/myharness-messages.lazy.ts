import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const myHarnessMessagesApi = (): ProviderStreams => lazyApi(() => import("./myharness-messages.ts"));
