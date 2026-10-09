import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderDispatcher, setProviderDispatcherResolver } from "../src/utils/provider-dispatcher.ts";
import { captureFetchErrors } from "../src/utils/provider-failure.ts";

afterEach(() => {
	setProviderDispatcherResolver(undefined);
	vi.unstubAllGlobals();
});

describe("provider dispatcher hook", () => {
	it("passes the provider's dispatcher to fetch and leaves other providers untouched", async () => {
		const dispatcher = { name: "qwen-dispatcher" };
		setProviderDispatcherResolver((provider) => (provider === "qwen" ? dispatcher : undefined));
		const fetchStub = vi.fn(async (_input: unknown, _init?: unknown) => new Response("ok"));
		vi.stubGlobal("fetch", fetchStub);

		await captureFetchErrors("qwen").fetch("https://example.test/a", { method: "POST" });
		expect(fetchStub.mock.calls[0]?.[1]).toEqual({ method: "POST", dispatcher });

		const init = { method: "GET" };
		await captureFetchErrors("other").fetch("https://example.test/b", init);
		expect(fetchStub.mock.calls[1]?.[1]).toBe(init);

		await captureFetchErrors().fetch("https://example.test/c");
		expect(fetchStub.mock.calls[2]?.[1]).toBeUndefined();
	});

	it("resolves nothing without a resolver", () => {
		expect(resolveProviderDispatcher("qwen")).toBeUndefined();
	});
});
