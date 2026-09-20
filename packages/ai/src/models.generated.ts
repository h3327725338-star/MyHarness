import type { Api, Model } from "./types.ts";

/**
 * The upstream generated model catalog is intentionally empty.
 * MyHarness loads models from the user's models.json or extensions.
 */
export const MODELS: Record<string, Record<string, Model<Api>>> = {};
