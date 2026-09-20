import type { ImagesApi, ImagesModel } from "./types.ts";

/** No upstream image model catalog is bundled. */
export const IMAGE_MODELS: Record<string, Record<string, ImagesModel<ImagesApi>>> = {};
