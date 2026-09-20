import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/providers/runtime/index.ts";

describe("ModelRuntime manual Provider startup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not fetch or populate an upstream Provider catalog", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			allowModelNetwork: true,
		});

		await expect(runtime.reloadConfig()).resolves.toBeUndefined();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(runtime.getProviders()).toEqual([]);
		expect(runtime.getModels()).toEqual([]);
	});
});
